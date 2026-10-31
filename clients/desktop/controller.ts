import { readPrivate } from "../cli/private-files.ts";
import { importDirect, loadProfile, profilePath } from "../cli/profile.ts";
import { credentialStore } from "../cli/credential-store.ts";
import { login } from "../cli/login.ts";
import { DeviceOAuthError } from "../connection/device-oauth.ts";
import { brand } from "../../brand.ts";
import { agentSetup } from "../cli/agent-setup.ts";
import { signOut } from "../cli/sign-out.ts";
import { ConnectionSupervisor } from "./supervisor.ts";
import type { DesktopRequest, DesktopReply, DesktopSnapshot } from "./contracts.ts";

export function desktopController(options: {
  home: string;
  configHome: string;
  env: NodeJS.ProcessEnv;
  connectionEntry: string;
  executable: string;
  openBrowser(url: string): Promise<void>;
  chooseDirectFile(): Promise<string | undefined>;
}) {
  const connection = new ConnectionSupervisor(
    options.home,
    options.connectionEntry,
    options.executable,
  );
  const setup = agentSetup({
    profileHome: options.home,
    configHome: options.configHome,
    env: options.env,
    brand,
  });
  let phase: DesktopSnapshot["phase"] = "starting";
  let configured = { claude: false, codex: false };
  let authorization: DesktopSnapshot["authorization"];
  let error: string | undefined;
  let hasProfile = false;
  let signIn: { abort: AbortController; finished: Promise<void> } | undefined;
  let mutation: Promise<DesktopReply> | undefined;

  const inspect = async () => {
    configured = (await setup.inspect()).configured;
  };
  const snapshot = async (): Promise<DesktopSnapshot> => {
    const current = hasProfile ? await connection.health().catch(() => undefined) : undefined;
    const origin = current ? await connection.origin().catch(() => undefined) : undefined;
    return {
      phase,
      configured,
      canReconnect:
        hasProfile && current?.state !== "revoked" && current?.state !== "sign-in-required",
      canSignOut: hasProfile,
      ...(current ? { connection: current } : {}),
      ...(origin ? { localOrigin: origin } : {}),
      ...(authorization ? { authorization } : {}),
      ...(error ? { error } : {}),
    };
  };
  const cancelSignIn = async () => {
    signIn?.abort.abort();
    await signIn?.finished;
  };
  const startSignIn = async (origin: string) => {
    await connection.stop();
    setup.cancel();
    const abort = new AbortController();
    phase = "signing-in";
    const finished = login(options.home, origin, "os", false, {
      signal: abort.signal,
      show: async (url, code) => {
        authorization = { url, code };
        try {
          await options.openBrowser(url);
        } catch {
          error = "The browser could not open. Open the approval address below in your browser.";
        }
      },
    })
      .then(async () => {
        hasProfile = true;
        await connection.start();
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        error =
          cause instanceof DeviceOAuthError && cause.code === "access_denied"
            ? "Device sign-in was denied. Start again when you're ready."
            : cause instanceof DeviceOAuthError && cause.code === "expired_token"
              ? "Device sign-in expired. Start again to get a new code."
              : "Sign-in could not finish. Check your connection, unlock your credential store and try again.";
      })
      .finally(() => {
        phase = "ready";
        authorization = undefined;
        signIn = undefined;
      });
    signIn = { abort, finished };
  };
  const handle = async (request: DesktopRequest): Promise<DesktopReply> => {
    if (request.action === "status") return { snapshot: await snapshot() };
    if (request.action === "cancel-sign-in") {
      await cancelSignIn();
      return { snapshot: await snapshot() };
    }
    if (request.action === "open-approval") {
      if (authorization) await options.openBrowser(authorization.url);
      return { snapshot: await snapshot() };
    }
    if (phase !== "ready") return { snapshot: await snapshot() };
    error = undefined;
    if (request.action === "sign-in") await startSignIn(request.origin);
    else if (request.action === "import-direct") {
      const file = await options.chooseDirectFile();
      if (file) {
        await connection.stop();
        setup.cancel();
        await importDirect(options.home, file, "os");
        hasProfile = true;
        await connection.start();
      }
    } else if (request.action === "setup-preview") {
      const needsConnection = Object.values(request.selection).includes("connect");
      const state = needsConnection ? await connection.status() : undefined;
      if (needsConnection && state?.state !== "connected")
        throw new Error("Reconnect before setting up agents.");
      const preview = await setup.preview(
        request.selection,
        state?.capabilities ?? [],
        needsConnection ? await connection.origin() : undefined,
      );
      return { snapshot: await snapshot(), preview };
    } else if (request.action === "undo-preview") {
      const preview = await setup.undoPreview();
      return { snapshot: await snapshot(), preview };
    } else if (request.action === "cancel-preview") setup.cancel();
    else if (request.action === "setup-apply") {
      await setup.apply(request.id);
      await inspect();
    } else if (request.action === "sign-out") {
      setup.cancel();
      await signOut(options.home);
      hasProfile = false;
      await connection.stop();
    } else {
      setup.cancel();
      if (request.action === "reconnect") await connection.start();
      await connection.command(request.action);
    }
    return { snapshot: await snapshot() };
  };
  return {
    initialize: async () => {
      try {
        await inspect();
      } catch {
        error =
          "Agent settings could not be read. Check their syntax, permissions and setup lock before reviewing changes.";
      }
      try {
        if ((await readPrivate(profilePath(options.home))) !== undefined) {
          hasProfile = true;
          const profile = await loadProfile(options.home);
          hasProfile =
            (await (await credentialStore(options.home, profile.storage)).read()) !== undefined;
        }
        if (hasProfile) await connection.start();
      } catch {
        error =
          "The connection could not start. Sign in again, or unlock your credential store and reconnect.";
      }
      phase = "ready";
    },
    request: (request: DesktopRequest): Promise<DesktopReply> => {
      if (["status", "cancel-sign-in", "open-approval"].includes(request.action))
        return handle(request).catch(async () => ({
          snapshot: {
            ...(await snapshot()),
            error: "The browser could not open. Use the approval address shown here.",
          },
        }));
      if (mutation)
        return snapshot().then((value) => ({
          snapshot: { ...value, error: "Finish the current action before starting another." },
        }));
      const pending = handle(request)
        .catch(async () => {
          error =
            request.action.startsWith("setup-") || request.action === "undo-preview"
              ? "Agent setup could not finish. Check config syntax, file permissions and the setup lock, then review again. Backups are kept."
              : request.action === "revoke"
                ? "Device revocation is unconfirmed. Check your account before retrying."
                : "The connection action could not finish. Check your sign-in and unlock your credential store, then retry.";
          return { snapshot: await snapshot() };
        })
        .finally(() => {
          mutation = undefined;
        });
      mutation = pending;
      return pending;
    },
    close: async () => {
      setup.cancel();
      await cancelSignIn();
      await mutation;
      await connection.stop();
    },
  };
}
