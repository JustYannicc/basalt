import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  readDesktopReply,
  readHostMessage,
  type DesktopReply,
  type DesktopRequest,
} from "../desktop/contracts.ts";
import { credentialStore } from "../cli/credential-store.ts";
import { nativeFixture } from "./native-fixture.ts";
import { launch, main } from "./support.ts";
import { ready } from "./native-client-fixture.ts";

test("the host schema accepts the lines the Swift shell encodes", async () => {
  const lines: string[] = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../desktop/host-messages.json", import.meta.url)),
      "utf8",
    ),
  );
  assert.equal(lines.length, 7);
  for (const line of lines) readHostMessage(JSON.parse(line));
});

const hostEntry = fileURLToPath(new URL("../desktop/host.ts", import.meta.url));
// File custody exists only for headless Linux. On a Mac this test writes OS keychain entries
// keyed by its temporary home, so it runs there only when asked.
const storage = process.platform === "linux" ? "file" : "os";
const skip =
  process.platform !== "linux" && process.env.SIGNALBOX_KEYCHAIN_TESTS !== "1"
    ? "Set SIGNALBOX_KEYCHAIN_TESTS=1 to use the OS keychain"
    : false;

const hosts = new Set<ReturnType<typeof spawn>>();

/** Talks to host.ts the way the Swift shell does: one JSON message per line each way. */
function startHost(home: string, config: string) {
  const child = spawn(
    process.execPath,
    [
      hostEntry,
      "--home",
      home,
      "--config-home",
      config,
      "--connection",
      main,
      "--storage",
      storage,
      "--no-browser",
    ],
    {
      env: {
        ...process.env,
        // macOS finds the login keychain through HOME, so only Linux gets a scratch HOME.
        ...(storage === "file" ? { HOME: config } : {}),
        CLAUDE_CONFIG_DIR: join(config, ".claude"),
        CODEX_HOME: join(config, ".codex"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const waiting = new Map<number, (value: { reply?: unknown; error?: string }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    waiting.get(value.id)?.(value);
  });
  let next = 0;
  const raw = (message: { id: number } & Record<string, unknown>) => {
    const answer = new Promise<{ reply?: unknown; error?: string }>((resolve) =>
      waiting.set(message.id, resolve),
    );
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return answer;
  };
  const send = async (request: DesktopRequest) => {
    const value = await raw({ id: ++next, request });
    assert.ok(value.reply, `Host refused ${request.action}`);
    return readDesktopReply(value.reply);
  };
  const until = async (check: (reply: DesktopReply) => boolean) => {
    // Device sign-in polls no faster than every five seconds.
    let last: DesktopReply | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      const reply = (last = await send({ action: "status" }));
      if (check(reply)) return reply;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`The host never reached the expected state: ${JSON.stringify(last?.snapshot)}`);
  };
  const exited = once(child, "close").then(([code]) => code);
  hosts.add(child);
  return {
    send,
    raw,
    until,
    close: async () => {
      child.stdin.end();
      return exited;
    },
  };
}

/**
 * A host answers status while it starts, and its connection answers before writing its local
 * address, so "connected" alone can be seen before the address exists. Ready follows startup or
 * sign-in, both of which wait for the connection to start; the address is checked directly too.
 */
const usable = (reply: DesktopReply) =>
  reply.snapshot.phase === "ready" &&
  reply.snapshot.connection?.state === "connected" &&
  reply.snapshot.localOrigin !== undefined;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

test(
  "the Mac host signs in, sets up agents, keeps its port and stops only its own connection",
  { skip },
  async () => {
    const remote = await nativeFixture();
    const home = await mkdtemp(join(tmpdir(), "mac-host-"));
    const config = await mkdtemp(join(tmpdir(), "mac-host-config-"));
    try {
      remote.approve();
      let host = startHost(home, config);
      assert.equal((await host.send({ action: "status" })).snapshot.canSignOut, false);

      // Refusals still answer their id, so the shell never waits on a bad message.
      assert.deepEqual(await host.raw({ id: 99, request: { action: "status" }, extra: true }), {
        id: 99,
        error: "refused",
      });
      assert.deepEqual(
        await host.raw({ id: 98, request: { action: "status" }, file: "/tmp/x.json" }),
        { id: 98, error: "refused" },
      );
      assert.deepEqual(
        await host.raw({ id: 97, request: { action: "sign-in", origin: "not a url" } }),
        { id: 97, error: "refused" },
      );

      // Actions sent while the host is still starting are ignored, so wait for it first.
      await host.until((reply) => reply.snapshot.phase === "ready");
      const signing = await host.send({ action: "sign-in", origin: remote.origin });
      assert.equal(signing.snapshot.phase, "signing-in");
      const connected = await host.until(usable);
      const origin = connected.snapshot.localOrigin;
      assert.match(origin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/u);

      const preview = await host.send({
        action: "setup-preview",
        selection: { claude: "connect", codex: "connect" },
      });
      assert.ok(preview.preview?.files.every((file) => file.path.startsWith(config)));
      const applied = await host.send({ action: "setup-apply", id: preview.preview!.id });
      assert.deepEqual(applied.snapshot.configured, { claude: true, codex: true });
      const token = JSON.parse(
        await readFile(join(home, "agent-desktop-codex.json"), "utf8"),
      ).token;

      // Quitting stops the connection this host started.
      assert.equal(await host.close(), 0);
      assert.equal(await exists(join(home, "runtime.json")), false);

      // The next launch takes over the same profile: same port, same agent credential, no sign-in.
      host = startHost(home, config);
      const resumed = await host.until(usable);
      assert.equal(resumed.snapshot.localOrigin, origin);
      assert.equal(
        JSON.parse(await readFile(join(home, "agent-desktop-codex.json"), "utf8")).token,
        token,
      );
      assert.deepEqual(resumed.snapshot.configured, { claude: true, codex: true });
      assert.equal(await host.close(), 0);

      // A connection another app started (the Electron app during an upgrade) is attached, not owned.
      const outside = launch(["run"], home);
      await ready(outside, /Connection ready at /u);
      host = startHost(home, config);
      await host.until(usable);
      assert.equal(await host.close(), 0);
      assert.equal(await exists(join(home, "runtime.json")), true);
      outside.child.kill("SIGTERM");
      assert.equal((await outside.exited).code, 0);

      host = startHost(home, config);
      await host.until(usable);
      const revoked = await host.send({ action: "revoke" });
      assert.equal(revoked.snapshot.connection?.state, "revoked");
      const signedOut = await host.send({ action: "sign-out" });
      assert.equal(signedOut.snapshot.canSignOut, false);
      assert.equal(await host.close(), 0);
    } finally {
      for (const child of hosts) if (child.exitCode === null) child.kill("SIGTERM");
      // A failed run must not leave a test entry in the OS keychain.
      if (storage === "os")
        await (await credentialStore(home, "os")).remove().catch(() => undefined);
      await remote.close();
      await rm(home, { recursive: true, force: true });
      await rm(config, { recursive: true, force: true });
    }
  },
);
