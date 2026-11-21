import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { desktopHome } from "../cli/profile.ts";
import { remoteFixture } from "./remote-fixture.ts";
import { command, fixtureHome, launch } from "./support.ts";

let remote: Awaited<ReturnType<typeof remoteFixture>>;
before(async () => {
  assert.equal(process.platform, "linux", "Fixture profiles use headless Linux file storage.");
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
  return launch(args, undefined, [], env).exited;
}

/** A person's home directory with the desktop app's profile, as Electron keeps it on Linux. */
async function person(work: (user: string, appHome: string, ownHome: string) => Promise<void>) {
  const user = await mkdtemp(join(tmpdir(), "signalbox-client-user-"));
  try {
    await work(
      user,
      join(user, ".config", "Signalbox Client", "connection"),
      join(user, ".local", "state", "signalbox", "client"),
    );
  } finally {
    await rm(user, { recursive: true, force: true });
  }
}

test(
  "agent add prints the running gateway's addresses and a key it accepts at once; remove refuses it at once",
  { timeout: 15_000 },
  async () => {
    const profile = await fixtureHome(remote.origin);
    try {
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
      }
    } finally {
      await profile.remove();
    }
  },
);

test(
  "without --home the CLI adds and removes keys on the desktop app's running connection",
  { timeout: 15_000 },
  () =>
    person(async (user, appHome, ownHome) => {
      const app = await fixtureHome(remote.origin, appHome);
      // The desktop app's supervisor runs this same connection on its own profile.
      const runtime = await app.start();
      try {
        const added = await bare(["agent", "add", "dictation", "models"], user);
        assert.equal(added.code, 0, added.stderr);
        const { lines, key } = pasted(added.stdout);
        assert.equal(lines[0], `OpenAI base URL: ${runtime.origin}/v1`);
        await stat(join(appHome, "agent-dictation.json"));
        await assert.rejects(stat(ownHome));
        assert.equal(await models(runtime.origin, { authorization: `Bearer ${key}` }), 200);

        const removed = await bare(["agent", "remove", "dictation"], user);
        assert.equal(removed.code, 0, removed.stderr);
        assert.equal(await models(runtime.origin, { authorization: `Bearer ${key}` }), 401);
      } finally {
        await runtime.stop();
      }
    }),
);

test(
  "an existing CLI profile keeps its place when the desktop app signs in later",
  { timeout: 15_000 },
  () =>
    person(async (user, appHome, ownHome) => {
      await fixtureHome(remote.origin, ownHome);
      await fixtureHome(remote.origin, appHome);
      const added = await bare(["agent", "add", "dictation", "models"], user);
      assert.equal(added.code, 0, added.stderr);
      await stat(join(ownHome, "agent-dictation.json"));
      await assert.rejects(stat(join(appHome, "agent-dictation.json")));
    }),
);

test("the desktop profile path matches each desktop app's own connection directory", () => {
  // HostLocation.defaultHome in desktop/mac: the keychain account and IPC path hash this string.
  assert.equal(
    desktopHome("darwin", {}, "/Users/person"),
    "/Users/person/Library/Application Support/Signalbox Client/connection",
  );
  // Electron's userData: appData plus productName "Signalbox Client", then "connection".
  assert.equal(
    desktopHome("linux", {}, "/home/person"),
    "/home/person/.config/Signalbox Client/connection",
  );
  assert.equal(
    desktopHome("linux", { XDG_CONFIG_HOME: "/home/person/xdg" }, "/home/person"),
    "/home/person/xdg/Signalbox Client/connection",
  );
  assert.equal(
    desktopHome("win32", { APPDATA: "C:\\Users\\person\\AppData\\Roaming" }, "C:\\Users\\person"),
    "C:\\Users\\person\\AppData\\Roaming\\Signalbox Client\\connection",
  );
});
