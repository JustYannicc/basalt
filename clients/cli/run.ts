import { lock } from "proper-lockfile";
import { join, dirname } from "node:path";
import { rm } from "node:fs/promises";
import { readDirectCredentials } from "../contracts/connection.ts";
import { directConnection } from "../connection/direct.ts";
import { credentialStore } from "./credential-store.ts";
import { startGateway } from "./gateway.ts";
import { tokenHash } from "./local-access.ts";
import { ipcPath, loadProfile, operatorToken, profilePath, withProfile } from "./profile.ts";
import { privateDirectory, writePrivate } from "./private-files.ts";

export async function run(home: string) {
  await privateDirectory(home);
  const release = await lock(home, { lockfilePath: join(home, ".running"), retries: 0 });
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    const profile = await loadProfile(home);
    const store = await credentialStore(home, profile.storage);
    const raw = await store.read();
    if (raw === undefined) throw new Error("Sign in before starting the connection.");
    const source = directConnection(readDirectCredentials(JSON.parse(raw)), store);
    const socket = ipcPath(home);
    if (process.platform !== "win32") {
      await privateDirectory(dirname(socket));
      // The exclusive profile lease owns this socket path, including recovery after a crash.
      await rm(socket, { force: true });
    }
    gateway = await startGateway({
      profile: () => loadProfile(home),
      source,
      operatorHash: tokenHash(await operatorToken(home)),
      ipcPath: socket,
      port: profile.port,
    });
    const port = Number(new URL(gateway.origin).port);
    await withProfile(home, async () => {
      const current = await loadProfile(home);
      await writePrivate(profilePath(home), JSON.stringify({ ...current, port }));
    });
    await writePrivate(
      join(home, "runtime.json"),
      JSON.stringify({ version: 1, origin: gateway.origin }),
    );
    process.stderr.write(`Connection ready at ${gateway.origin}.\n`);
    let stop: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      stop = resolve;
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await finished;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await gateway?.close();
    await rm(join(home, "runtime.json"), { force: true });
    await release();
  }
}
