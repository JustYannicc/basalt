import { spawn } from "node:child_process";
import { readProfile } from "../contracts/connection.ts";
import { signInDevice } from "../connection/device-oauth.ts";
import { authRequest } from "../connection/device-oauth.ts";
import { readNativeAccess } from "../contracts/device.ts";
import { credentialStore } from "./credential-store.ts";
import { profilePath, withStoppedConnection, withProfile } from "./profile.ts";
import { readPrivate, writePrivate } from "./private-files.ts";

export async function login(
  home: string,
  origin: string,
  storage: "os" | "file",
  browser: boolean,
  options?: { signal: AbortSignal; show: (url: string, code: string) => Promise<void> },
) {
  return withStoppedConnection(home, async () => {
    const raw = await readPrivate(profilePath(home));
    const profile =
      raw === undefined
        ? readProfile({ version: 1, storage, port: 0, agents: [] })
        : readProfile(JSON.parse(raw));
    if (profile.storage !== storage)
      throw new Error("Keep this profile's credential storage choice.");
    const store = await credentialStore(home, storage);
    await store.read();
    const controller = new AbortController();
    const signal = options
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const abort = () => controller.abort(new Error("Sign-in cancelled."));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const credentials = await signInDevice(origin, {
        signal,
        show: async (url, code) => {
          if (options) return options.show(url, code);
          process.stderr.write(
            `Approve this device in your browser: ${url}\nConfirmation code: ${code}\n`,
          );
          if (browser) await openBrowser(url);
        },
      });
      // Validate current authority before exposing the saved grant to a connection process.
      const response = await authRequest(
        credentials.origin,
        "/api/auth/native/access",
        {
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        },
        signal,
      );
      if (!response.ok) throw new Error("The new device cannot access this server.");
      const access = readNativeAccess(await response.json());
      if (access.clientId !== credentials.clientId || access.expiresAt <= Date.now())
        throw new Error("The new device grant is incompatible.");
      await withProfile(home, async () => {
        const latest = await readPrivate(profilePath(home));
        const current = latest === undefined ? profile : readProfile(JSON.parse(latest));
        if (current.storage !== storage)
          throw new Error("Credential storage changed during sign-in.");
        await store.write(JSON.stringify(credentials));
        await writePrivate(profilePath(home), JSON.stringify(current));
      });
      process.stderr.write(
        "Native device sign-in saved. Run the connection to serve local agents.\n",
      );
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  });
}
async function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Open the displayed approval URL in your browser.")),
    );
  });
}
