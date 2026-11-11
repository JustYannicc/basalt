import { Schema } from "effect";
import type {
  AppSummary,
  Capability,
  ConnectionView,
  CredentialSource,
} from "../contracts/connection.ts";
import {
  readDeviceCredentials,
  readNativeAccess,
  type DeviceCredentials,
  type NativeAccess,
} from "../contracts/device.ts";
import { tunnelPath } from "../contracts/tunnel.ts";
import { authRequest, tokenRequest } from "./device-oauth.ts";
import { openTunnel } from "./tunnel.ts";
import type { SocketFactory } from "../contracts/transport.ts";

/** The inventory fields the summary needs; other fields are ignored. */
const Inventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, name: Schema.String })),
  links: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
  appLinks: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
  accountCounts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ app: Schema.String, count: Schema.Int })),
  ),
});
const readInventory = Schema.decodeUnknownSync(Inventory);

export function deviceConnection(
  initial: DeviceCredentials,
  store: {
    read(): Promise<string | undefined>;
    write(value: string): Promise<void>;
    remove(): Promise<void>;
  },
  socket: SocketFactory,
): CredentialSource {
  let saved: DeviceCredentials | undefined = initial;
  let access: NativeAccess | undefined;
  let display: NativeAccess["display"];
  let state: ConnectionView["state"] = "connected";
  let pending: Promise<void> | undefined;
  let epoch = 0;
  const capabilities = (): Capability[] =>
    access
      ? [
          ...(access.policy.models ? ["models" as const] : []),
          ...(access.policy.toolsOrganization ? ["tools" as const] : []),
        ]
      : [];
  const renew = async (current: DeviceCredentials, signal: AbortSignal, generation: number) => {
    // Persist intent first: a lost refresh response must not be repeated after restart.
    await store.write(JSON.stringify({ ...current, refreshPending: true }));
    saved = { ...current, refreshPending: true };
    const tokens = await tokenRequest(
      current.origin,
      {
        grant_type: "refresh_token",
        resource: `${current.origin}/native`,
        client_id: current.clientId,
        refresh_token: current.refreshToken,
      },
      signal,
    );
    const next = { ...current, ...tokens, refreshPending: false };
    if (generation !== epoch) throw new Error("Connection state changed.");
    await store.write(JSON.stringify(next));
    saved = next;
  };
  const validate = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = saved;
    if (state !== "connected") throw new Error("The connection is not connected.");
    if (!current || (current.refreshPending && !pending)) {
      state = "sign-in-required";
      throw new Error("Sign in again before using this device.");
    }
    const generation = epoch;
    try {
      if (!pending && current.expiresAt <= Date.now() + 30_000) {
        pending = renew(current, signal, generation).finally(() => {
          pending = undefined;
        });
      }
      await pending;
      signal.throwIfAborted();
      const next = saved;
      if (generation !== epoch || state !== "connected" || !next)
        throw new Error("Connection state changed.");
      const response = await authRequest(
        next.origin,
        "/api/auth/native/access",
        {
          headers: { authorization: `Bearer ${next.accessToken}` },
        },
        signal,
      );
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) state = "sign-in-required";
        throw new Error("Native access is unavailable.");
      }
      const checked = readNativeAccess(await response.json());
      if (
        checked.clientId !== next.clientId ||
        checked.expiresAt <= Date.now() ||
        (!checked.policy.models && checked.policy.toolsOrganization === undefined)
      )
        throw new Error("Native access is incompatible.");
      if (generation !== epoch) throw new Error("Connection state changed.");
      access = checked;
      display = checked.display;
    } catch (error) {
      if (state === "connected" && saved?.refreshPending && !pending) state = "sign-in-required";
      else if (state === "connected" && !signal.aborted) state = "disconnected";
      if (!signal.aborted || state !== "connected") access = undefined;
      throw error;
    }
  };
  const authorize = async (signal: AbortSignal) => {
    await validate(signal);
    signal.throwIfAborted();
    if (state !== "connected" || !saved || !access)
      throw new Error("The connection is unavailable.");
    return saved;
  };
  return {
    origins: () => (saved ? [saved.origin] : []),
    view: () => ({
      state,
      mode: "device",
      capabilities: state === "connected" ? capabilities() : [],
      ...(display ? { display } : {}),
      ...(saved ? { origin: saved.origin } : {}),
    }),
    // A panel read never re-validates, so a failed list or network blip can't disconnect the
    // agents using this connection. An idle grant shares the one renewal agents use; closing the
    // panel can't abort it, and an uncertain renewal needs sign-in exactly as it would for agents.
    apps: async (signal): Promise<AppSummary | undefined> => {
      const generation = epoch;
      const organization = access?.policy.toolsOrganization;
      if (state !== "connected" || !saved || !access) throw new Error("Not connected.");
      if (organization === undefined) return undefined;
      if (!pending && !saved.refreshPending && saved.expiresAt <= Date.now() + 30_000) {
        pending = renew(saved, AbortSignal.timeout(30_000), generation).finally(() => {
          pending = undefined;
        });
      }
      await pending?.catch(() => undefined);
      const current = saved;
      if (generation !== epoch || state !== "connected" || !current)
        throw new Error("Connection state changed.");
      if (current.refreshPending) {
        state = "sign-in-required";
        access = undefined;
        throw new Error("Sign in again before using this device.");
      }
      const response = await globalThis.fetch(
        new URL(`/api/organizations/${encodeURIComponent(organization)}/inventory`, current.origin),
        {
          headers: { authorization: `Bearer ${current.accessToken}` },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("The app list is unavailable.");
      }
      const inventory = readInventory(await response.json());
      // A sign-out or disconnect during the read leaves nothing for the panel to show.
      if (generation !== epoch) throw new Error("Connection state changed.");
      const counts = new Map(inventory.accountCounts?.map(({ app, count }) => [app, count]));
      // Without server counts, only the caller's own links are known.
      const linked = new Map<string, Set<string>>();
      for (const link of [...inventory.links, ...inventory.appLinks])
        linked.set(link.app, (linked.get(link.app) ?? new Set()).add(link.account));
      return {
        organization,
        apps: inventory.apps.map((app) => ({
          id: app.id,
          name: app.name,
          accounts: counts.get(app.id) ?? linked.get(app.id)?.size ?? 0,
        })),
      };
    },
    transport: async (signal) => {
      const current = await authorize(signal);
      return {
        mode: "device",
        capabilities: capabilities(),
        open: (request, operationSignal) => {
          if (state !== "connected" || current !== saved)
            throw new Error("Connection state changed.");
          const url = new URL(tunnelPath, current.origin);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          return openTunnel(socket(url.href, current.accessToken), request, operationSignal);
        },
      };
    },
    disconnect: async () => {
      epoch++;
      state = "disconnected";
      access = undefined;
      await pending?.catch(() => undefined);
    },
    reconnect: async () => {
      await pending?.catch(() => undefined);
      const raw = await store.read();
      saved = raw === undefined ? undefined : readDeviceCredentials(JSON.parse(raw));
      state = "connected";
      await authorize(new AbortController().signal);
    },
    signOut: async () => {
      epoch++;
      state = "sign-in-required";
      access = undefined;
      display = undefined;
      await pending?.catch(() => undefined);
      saved = undefined;
      await store.remove();
    },
    revoke: async () => {
      const current = await authorize(new AbortController().signal);
      const response = await authRequest(
        current.origin,
        "/api/auth/native/revoke",
        {
          method: "POST",
          headers: { authorization: `Bearer ${current.accessToken}` },
        },
        new AbortController().signal,
      );
      if (!response.ok)
        throw new Error("Device revocation is unconfirmed. Check your account before retrying.");
      epoch++;
      state = "revoked";
      access = undefined;
      display = undefined;
      saved = undefined;
      await store.remove();
    },
  };
}
