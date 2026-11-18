import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as profiles from "../cli/profile.ts";
import { remoteFixture } from "./remote-fixture.ts";
import { command, fixtureHome, main, root } from "./support.ts";

let remote: Awaited<ReturnType<typeof remoteFixture>>;
before(async () => {
  remote = await remoteFixture();
});
after(() => remote?.close());

const models = async (origin: string, headers: Record<string, string>) => {
  const response = await fetch(`${origin}/v1/models`, { headers });
  await response.body?.cancel();
  return response.status;
};

/** What a person pastes into another app: the gateway's addresses, then the key on the last line. */
function pasted(stdout: string) {
  const lines = stdout.trimEnd().split("\n");
  const key = /^API key: ([a-zA-Z0-9_-]{43})$/u.exec(lines.at(-1) ?? "")?.[1];
  assert.ok(key, `agent add printed no key: ${JSON.stringify(stdout)}`);
  return { lines, key };
}

/** The CLI as a person runs it: no --home, with only their own home directory to go by. */
async function bare(args: readonly string[], user: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: user };
  delete env.XDG_CONFIG_HOME;
  const child = spawn(process.execPath, [main, ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test(
  "agent add prints the running gateway's addresses and a key it accepts at once; remove refuses it at once",
  { timeout: 15_000 },
  async () => {
    const profile = await fixtureHome(remote.origin);
    const runtime = await profile.start();
    try {
      const added = await command(["agent", "add", "dictation", "models", "tools"], profile.home);
      const { lines, key } = pasted(added.stdout);
      assert.deepEqual(lines, [
        `OpenAI base URL: ${runtime.origin}/v1`,
        `Anthropic base URL: ${runtime.origin}`,
        `MCP URL: ${runtime.origin}/mcp`,
        `API key: ${key}`,
      ]);
      assert.ok(!added.stderr.includes(key), "The key is printed once, on stdout only.");
      assert.equal(await models(runtime.origin, { authorization: `Bearer ${key}` }), 200);
      assert.equal(await models(runtime.origin, { "x-api-key": key }), 200);

      await command(["agent", "remove", "dictation"], profile.home);
      assert.equal(await models(runtime.origin, { authorization: `Bearer ${key}` }), 401);
      assert.equal(await models(runtime.origin, { "x-api-key": key }), 401);
    } finally {
      await runtime.stop();
      await profile.remove();
    }
  },
);

test(
  "without --home the CLI adds and removes keys on the desktop app's running connection",
  { timeout: 15_000 },
  async () => {
    const user = await mkdtemp(join(tmpdir(), "signalbox-client-user-"));
    // The Mac app's HostLocation.defaultHome; Electron's userData elsewhere.
    const appHome =
      process.platform === "darwin"
        ? join(user, "Library", "Application Support", "Signalbox Client", "connection")
        : join(user, ".config", "Signalbox Client", "connection");
    const ownHome = join(user, ".local", "state", "signalbox", "client");
    try {
      const app = await fixtureHome(remote.origin, appHome);
      // The desktop app's supervisor runs this same connection on its own profile.
      const runtime = await app.start();
      try {
        const added = await bare(["agent", "add", "dictation", "models"], user);
        assert.equal(added.code, 0, added.stderr);
        const { lines, key } = pasted(added.stdout);
        assert.equal(lines[0], `OpenAI base URL: ${runtime.origin}/v1`);
        await stat(join(appHome, "agent-dictation.json"));
        await assert.rejects(stat(join(ownHome, "agent-dictation.json")));
        assert.equal(await models(runtime.origin, { authorization: `Bearer ${key}` }), 200);

        const removed = await bare(["agent", "remove", "dictation"], user);
        assert.equal(removed.code, 0, removed.stderr);
        assert.equal(await models(runtime.origin, { authorization: `Bearer ${key}` }), 401);
      } finally {
        await runtime.stop();
      }
    } finally {
      await rm(user, { recursive: true, force: true });
    }
  },
);

test("the CLI keeps its own profile when no desktop app has signed in", async () => {
  const user = await mkdtemp(join(tmpdir(), "signalbox-client-user-"));
  try {
    const result = await bare(["agent", "add", "dictation", "models"], user);
    assert.equal(result.code, 1, "There is no profile to add a key to yet.");
    await stat(join(user, ".local", "state", "signalbox", "client"));
  } finally {
    await rm(user, { recursive: true, force: true });
  }
});

test("the desktop profile path matches each desktop app's own connection directory", () => {
  const desktopHome = (profiles as Record<string, unknown>).desktopHome;
  assert.equal(typeof desktopHome, "function", "The CLI has no desktop profile resolver.");
  const resolve = desktopHome as typeof profiles.desktopHome;
  // HostLocation.defaultHome in desktop/mac: the keychain account and IPC path hash this string.
  assert.equal(
    resolve("darwin", {}, "/Users/person"),
    "/Users/person/Library/Application Support/Signalbox Client/connection",
  );
  // Electron's userData: appData plus productName "Signalbox Client", then "connection".
  assert.equal(
    resolve("linux", {}, "/home/person"),
    "/home/person/.config/Signalbox Client/connection",
  );
  assert.equal(
    resolve("linux", { XDG_CONFIG_HOME: "/home/person/xdg" }, "/home/person"),
    "/home/person/xdg/Signalbox Client/connection",
  );
  assert.equal(
    resolve("win32", { APPDATA: "C:\\Users\\person\\AppData\\Roaming" }, "C:\\Users\\person"),
    "C:\\Users\\person\\AppData\\Roaming\\Signalbox Client\\connection",
  );
});
