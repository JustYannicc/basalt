import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import childProcess, { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { withCacheLock } from "./upstream-cache.ts";
import { installUpstreamDependencies } from "./upstream-dependencies.ts";
import { collectUpstreamDependencies, createInstallAttempt } from "./upstream-store.ts";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "basalt-key-gc-")));
  const cache = join(root, "cache");
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  process.env.BASALT_UPSTREAM_CACHE = cache;
  const usage = { files: new Set<string>(), unavailable: false };
  const run = childProcess.spawnSync;
  const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  // Unit fixtures own their usage snapshot; unrelated worktrees and host lsof failures cannot alter it.
  const probe = t.mock.method(
    childProcess,
    "spawnSync",
    (...parameters: Parameters<typeof run>) => {
      const [command, args] = parameters;
      if (command === "lsof") {
        assert.deepEqual(args, ["-nP", "-F0n"]);
        return {
          pid: 0,
          output: [null, "", ""],
          stdout: [...usage.files].map((path) => `n${path}\0`).join("\n"),
          stderr: "",
          status: usage.unavailable ? 2 : 0,
          signal: null,
        };
      }
      if (command === "git" && args?.[0] === "-C" && args[1] === repository) {
        assert.deepEqual(args.slice(2), ["worktree", "list", "--porcelain", "-z"]);
        return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
      }
      return run(...parameters);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    probe.mock.restore();
    syncBuiltinESMExports();
  });
  t.after(() => {
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const key = (number: number, pin = "current") => {
    const name = number.toString(16).padStart(64, "0");
    const entry = join(cache, "prepared", pin, name);
    const store = join(entry, "generations", "published");
    mkdirSync(join(store, "node_modules"), { recursive: true });
    writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
    writeFileSync(
      join(store, "ready.json"),
      JSON.stringify({ key: name, trees: ["node_modules"] }),
    );
    writeFileSync(join(store, "node_modules", "payload"), "package bytes");
    chmodSync(join(store, "node_modules"), 0o555);
    symlinkSync("generations/published", join(entry, "current"));
    writeFileSync(join(entry, "last-used"), "");
    utimesSync(join(entry, "last-used"), number, number);
    return { entry, store };
  };
  return { root, cache, key, usage };
}

test("prepare collection retains the three most recently used keys and evicts older pins", async (t) => {
  const { key } = fixture(t);
  const entries = Array.from({ length: 5 }, (_, index) => key(index + 1));
  const oldPin = key(100, "old");
  await collectUpstreamDependencies("current");
  assert.deepEqual(
    entries.map(({ entry }) => existsSync(entry)),
    [false, false, true, true, true],
  );
  for (const { store } of entries.slice(2))
    assert.equal(readFileSync(join(store, "node_modules", "payload"), "utf8"), "package bytes");
  assert.equal(existsSync(oldPin.entry), false);
});

test("an open file protects its generation and key beyond the recent-key bound", async (t) => {
  const { key, usage } = fixture(t);
  const held = key(1, "old");
  for (let index = 2; index <= 5; index++) key(index);
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require('node:fs').openSync(${JSON.stringify(join(held.store, "node_modules/payload"))},'r');process.on('message',()=>process.exit(0));process.send('ready');`,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await once(child, "message");
  usage.files.add(join(held.store, "node_modules/payload"));
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(held.store), true);
  const exit = once(child, "exit");
  child.send("close");
  await exit;
  usage.files.clear();
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(held.entry), false);
});

test("a registered worktree reference protects a key without a consumer registration", async (t) => {
  const { root, cache, key } = fixture(t);
  const held = key(1, "old");
  const linked = key(2, "old");
  for (let index = 3; index <= 6; index++) key(index);
  const repository = join(root, "source");
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repository, "source"), "fixture");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const bare = join(cache, "repositories/fixture.git");
  mkdirSync(join(cache, "repositories"), { recursive: true });
  git("clone", "--bare", repository, bare);
  const checkout = join(root, "registered");
  git("--git-dir", bare, "worktree", "add", "--detach", checkout);
  const alias = join(root, "cache-alias");
  symlinkSync(cache, alias);
  writeFileSync(
    join(checkout, ".basalt-dependencies.json"),
    JSON.stringify({
      store: held.store.replace(cache, alias),
    }),
  );
  mkdirSync(join(checkout, "node_modules/.bun"), { recursive: true });
  symlinkSync(join(linked.store, "node_modules"), join(checkout, "node_modules/.bun/package"));
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(held.store), true);
  assert.equal(
    existsSync(linked.store),
    true,
    "actual package links survive a stale checkout marker",
  );
  git("--git-dir", bare, "worktree", "remove", "--force", checkout);
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(held.entry), false);
  assert.equal(existsSync(linked.entry), false);
});

test("failed open-handle observation skips collection rather than guessing", async (t) => {
  const { key, usage } = fixture(t);
  const old = key(1, "old");
  usage.unavailable = true;
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(old.store), true);
  assert.equal(readdirSync(join(old.entry, "generations")).length, 1);
});

function packageFixture(t: TestContext) {
  const fixtureState = fixture(t);
  const root = join(fixtureState.root, "consumer");
  const create = () => {
    mkdirSync(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "cache-gc-fixture",
        dependencies: { "is-number": "7.0.0" },
      }),
    );
    writeFileSync(join(root, "bunfig.toml"), '[install]\nlinker = "isolated"\n');
    execFileSync("bun", ["install", "--ignore-scripts", "--backend=copyfile"], {
      cwd: root,
      stdio: "pipe",
    });
  };
  const previous = process.env.BUN_INSTALL_CACHE_DIR;
  process.env.BUN_INSTALL_CACHE_DIR = join(fixtureState.root, "bun-cache");
  t.after(() => {
    if (previous === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previous;
  });
  create();
  return { ...fixtureState, consumer: root, create };
}

test("a cache hit refreshes recency before the next eviction", async (t) => {
  const { key, consumer } = packageFixture(t);
  const first = await installUpstreamDependencies(consumer, "current");
  const entry = dirname(dirname(first.store));
  utimesSync(join(entry, "last-used"), 1, 1);
  const others = [key(2), key(3), key(4)];
  const hit = await installUpstreamDependencies(consumer, "current");
  assert.equal(hit.store, first.store, "the published generation is reused");
  // Release the consumer so only the cache hit's recency can retain this key.
  rmSync(consumer, { recursive: true });
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(first.store), true);
  assert.deepEqual(
    others.map(({ entry }) => existsSync(entry)),
    [false, true, true],
  );
});

test("interrupted eviction retires the key before deletion and prepare rebuilds it", async (t) => {
  const { root, cache, key, consumer, create } = packageFixture(t);
  mkdirSync(cache, { recursive: true });
  const alias = join(root, "cache-alias");
  symlinkSync(cache, alias);
  process.env.BASALT_UPSTREAM_CACHE = alias;
  const first = await installUpstreamDependencies(consumer, "current");
  const entry = dirname(dirname(first.store));
  rmSync(consumer, { recursive: true });
  utimesSync(join(entry, "last-used"), 1, 1);
  for (let index = 2; index <= 4; index++) key(index);
  let retired: string | undefined;
  const remove = fs.rmSync;
  const interrupt: typeof fs.rmSync = (path, options) => {
    if (String(path).startsWith(join(cache, "prepared/current/.gc-"))) {
      retired = String(path);
      assert.equal(existsSync(entry), false, "the canonical key is already unavailable");
      remove(join(retired, "generations"), { recursive: true });
      throw Object.assign(new Error("Interrupted removal"), { code: "EIO" });
    }
    return remove(path, options);
  };
  const mocked = t.mock.method(fs, "rmSync", interrupt);
  syncBuiltinESMExports();
  try {
    await collectUpstreamDependencies("current");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(retired, "the eviction reached the interrupted delete");
  assert.equal(existsSync(retired), true);
  create();
  const rebuilt = await installUpstreamDependencies(consumer, "current");
  assert.equal(rebuilt.key, first.key);
  assert.notEqual(rebuilt.store, first.store);
  assert.match(
    readFileSync(join(consumer, "node_modules/is-number/index.js"), "utf8"),
    /module.exports/,
  );
  assert.equal(existsSync(retired), false, "the next prepare also removes the retired remainder");
});

test("live key locks and install attempts protect keys until their owners release them", async (t) => {
  const { key } = fixture(t);
  const locked = key(1, "old"),
    pending = key(2, "old");
  const attempt = await createInstallAttempt(pending.entry);
  for (let index = 3; index <= 6; index++) key(index);
  await withCacheLock(`${locked.entry}.lock`, async () => {
    await collectUpstreamDependencies("current");
    assert.equal(existsSync(locked.store), true);
    assert.equal(existsSync(attempt), true);
  });
  rmSync(join(attempt, "parent.json"));
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(locked.entry), false);
  assert.equal(existsSync(pending.entry), false);
});

test("legacy sibling attempts retain their parent key's live PID-only lock", async (t) => {
  const { key } = fixture(t);
  const legacy = key(1, "old");
  rmSync(join(legacy.entry, "store-format.json"));
  const attempt = `${legacy.entry}.attempt-${randomUUID()}`;
  mkdirSync(attempt);
  writeFileSync(join(attempt, "package.json"), "{}");
  symlinkSync(JSON.stringify({ pid: process.pid, id: "legacy-fixture" }), `${legacy.entry}.lock`);
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(attempt), true, "format-2 input copying holds the parent key lock");
  assert.equal(existsSync(legacy.store), true);
  rmSync(`${legacy.entry}.lock`);
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(attempt), false);
  assert.equal(existsSync(legacy.entry), false);
});
