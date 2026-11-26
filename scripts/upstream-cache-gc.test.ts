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
import { basename, dirname, join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { withCacheLock } from "./upstream-cache.ts";
import { generationName, installUpstreamDependencies } from "./upstream-dependencies.ts";
import {
  collectUpstreamDependencies,
  createInstallAttempt,
  rememberDependencyConsumer,
  withDependencyStoreLock,
} from "./upstream-store.ts";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "basalt-key-gc-")));
  const cache = join(root, "cache");
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  process.env.BASALT_UPSTREAM_CACHE = cache;
  const usage = { files: new Set<string>(), unavailable: false };
  const run = childProcess.spawnSync;
  const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const inventory = { matches: 0, unexpected: new Set<string>() };
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
      if (
        command === "git" &&
        args?.[0] === "-C" &&
        typeof args[1] === "string" &&
        realpathSync(args[1]) === repository
      ) {
        inventory.matches++;
        assert.deepEqual(args.slice(2), ["worktree", "list", "--porcelain", "-z"]);
        return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
      }
      if (command === "git") {
        const target =
          args?.[0] === "-C" && typeof args[1] === "string" ? realpathSync(args[1]) : "";
        if (target !== root && !target.startsWith(root + sep)) {
          inventory.unexpected.add(target);
          throw new Error("Fixture refused Git outside its temporary worktrees");
        }
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
    assert.deepEqual(
      [...inventory.unexpected],
      [],
      "Fixture must not query a real worktree inventory",
    );
    assert.ok(inventory.matches > 0, "Repository worktree inventory mock did not match");
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
  return { root, cache, key, usage, inventory };
}

test("fixture intercepts repository inventory with or without trailing separators", (t) => {
  const { inventory } = fixture(t);
  const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  for (const path of [repository, repository + sep]) {
    const result = childProcess.spawnSync(
      "git",
      ["-C", path, "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  }
  assert.equal(inventory.matches, 2);
});

test("collection evicts every unleased key, including recent keys, and keeps a live consumer", async (t) => {
  const { root, key } = fixture(t);
  const unused = key(100);
  const leased = key(1);
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, ".basalt-dependencies.json"),
    JSON.stringify({ store: leased.store }),
  );
  await withDependencyStoreLock(() => rememberDependencyConsumer(consumer, leased.store, false));
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(unused.entry), false, "recent but unleased keys are evicted");
  assert.equal(
    readFileSync(join(leased.store, "node_modules", "payload"), "utf8"),
    "package bytes",
  );
  rmSync(consumer, { recursive: true });
  await collectUpstreamDependencies();
  assert.equal(existsSync(leased.entry), false, "explicit GC needs no pin to evict unused keys");
});

test("an abandoned pending consumer does not retain keys it never installed", async (t) => {
  const { root, cache, key } = fixture(t);
  const abandoned = key(1),
    installed = key(2);
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, ".basalt-dependencies.json"),
    JSON.stringify({ store: installed.store }),
  );
  mkdirSync(join(cache, "consumers"), { recursive: true });
  writeFileSync(
    join(cache, "consumers", "legacy.json"),
    JSON.stringify({ root: consumer, stores: [abandoned.store, installed.store], pending: true }),
  );
  await collectUpstreamDependencies();
  assert.equal(existsSync(abandoned.entry), false);
  assert.equal(existsSync(installed.entry), true);
});

test("a live pending consumer retains its selected generation until installation finishes", async (t) => {
  const { root, key } = fixture(t);
  const selected = key(1);
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  await withDependencyStoreLock(() => rememberDependencyConsumer(consumer, selected.store, true));
  await collectUpstreamDependencies();
  assert.equal(existsSync(selected.store), true);
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

/** Worktrees registered with a repository under the fixture cache, as prepared checkouts are. */
function registered(root: string, cache: string, count: number) {
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
  return Array.from({ length: count }, (_, index) => {
    const checkout = join(root, `registered-${index}`);
    git("--git-dir", bare, "worktree", "add", "--detach", checkout);
    return checkout;
  });
}

/** The `.bun` directory's identity, as an install records it in its marker. */
const links = (bun: string) => {
  const stat = fs.lstatSync(bun, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) };
};

/** Links a checkout's packages into `store` and writes its marker afterwards, as an install does. */
function installed(checkout: string, store: string, packages: number, recorded: unknown = true) {
  const bun = join(checkout, "node_modules/.bun");
  mkdirSync(bun, { recursive: true });
  for (let index = 0; index < packages; index++)
    symlinkSync(join(store, "node_modules"), join(bun, `package-${index}`));
  // An earlier time than any later change can get, on any clock, and not a whole second.
  fs.utimesSync(bun, 1_700_000_000.25, 1_700_000_000.25);
  writeFileSync(
    join(checkout, ".basalt-dependencies.json"),
    JSON.stringify({
      store,
      ...(recorded === false ? {} : { links: recorded === true ? links(bun) : recorded }),
    }),
  );
  return bun;
}

/** Counts what collection lists or reads inside the registered checkouts' link directories. */
function linkReads(t: TestContext, root: string) {
  const reads = { count: 0 };
  const inside = (path: unknown) =>
    String(path).startsWith(join(root, "registered-")) && String(path).includes(".bun");
  const read = fs.readlinkSync,
    list = fs.readdirSync;
  const probes = [
    t.mock.method(fs, "readlinkSync", (...parameters: Parameters<typeof read>) => {
      if (inside(parameters[0])) reads.count++;
      return read(...parameters);
    }),
    t.mock.method(fs, "readdirSync", ((...parameters: Parameters<typeof list>) => {
      if (inside(parameters[0])) reads.count++;
      return list(...parameters);
    }) as typeof list),
  ];
  syncBuiltinESMExports();
  t.after(() => {
    for (const probe of probes) probe.mock.restore();
    syncBuiltinESMExports();
  });
  return reads;
}

test("checkouts whose links are unchanged since their install are not read link by link", async (t) => {
  const { root, cache, key } = fixture(t);
  const unused = key(1, "old");
  const elsewhere = join(root, "other-cache/store");
  mkdirSync(join(elsewhere, "node_modules"), { recursive: true });
  for (const checkout of registered(root, cache, 3)) installed(checkout, elsewhere, 20);
  const reads = linkReads(t, root);
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(unused.entry), false, "the collection pass ran");
  assert.equal(reads.count, 0);
});

test("a link replaced after its marker was written still protects the store it points into", async (t) => {
  const { root, cache, key } = fixture(t);
  const held = key(1, "old");
  const linked = key(2, "old");
  for (let index = 3; index <= 6; index++) key(index);
  const [checkout] = registered(root, cache, 1);
  const bun = installed(checkout!, held.store, 2);
  // A legacy installer swaps one link into another generation and has not rewritten the marker.
  symlinkSync(join(linked.store, "node_modules"), join(bun, "replacement"));
  fs.renameSync(join(bun, "replacement"), join(bun, "package-1"));
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(held.store), true);
  assert.equal(existsSync(linked.store), true, "the replaced link is read, not trusted");
});

test("a link tree swapped whole after its marker was written still protects its new store", async (t) => {
  const { root, cache, key } = fixture(t);
  const held = key(1, "old");
  const linked = key(2, "old");
  for (let index = 3; index <= 6; index++) key(index);
  const [checkout] = registered(root, cache, 1);
  const bun = installed(checkout!, held.store, 2);
  // A legacy installer renames a new link tree into place and dies before writing its marker.
  const replacement = join(checkout!, "node_modules/.bun-replacement");
  mkdirSync(replacement);
  symlinkSync(join(linked.store, "node_modules"), join(replacement, "package-0"));
  rmSync(bun, { recursive: true });
  fs.renameSync(replacement, bun);
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(linked.store), true, "the new tree is read, not trusted");
});

test("a checkout whose install is still pending keeps both its marker's and its new store", async (t) => {
  const { root, cache, key } = fixture(t);
  const previous = key(1, "old");
  const selected = key(2, "old");
  for (let index = 3; index <= 6; index++) key(index);
  const [checkout] = registered(root, cache, 1);
  installed(checkout!, previous.store, 2);
  // The new generation is chosen and registered before any link moves.
  await withDependencyStoreLock(() => rememberDependencyConsumer(checkout!, selected.store, true));
  const reads = linkReads(t, root);
  await collectUpstreamDependencies("current");
  assert.equal(reads.count, 0, "unchanged links are not read, so the registration alone protects");
  assert.equal(existsSync(previous.store), true);
  assert.equal(existsSync(selected.store), true);
});

test("a marker that cannot vouch for its links has them read one by one", async (t) => {
  const { root, cache, key } = fixture(t);
  const held = key(1, "old");
  const linked = key(2, "old");
  for (let index = 3; index <= 6; index++) key(index);
  const [coarse, unknown, none] = registered(root, cache, 3);
  for (const [checkout, recorded] of [
    [coarse!, true],
    [unknown!, "unchecked"],
    [none!, false],
  ] as const) {
    const bun = installed(checkout, held.store, 1, recorded);
    symlinkSync(join(linked.store, "node_modules"), join(bun, "package-0-linked"));
    if (checkout === coarse) {
      // A whole-second mtime may hide a later change on a coarse clock.
      fs.utimesSync(bun, 1_700_000_000, 1_700_000_000);
      const marker = JSON.parse(readFileSync(join(checkout, ".basalt-dependencies.json"), "utf8"));
      writeFileSync(
        join(checkout, ".basalt-dependencies.json"),
        JSON.stringify({ ...marker, links: links(bun) }),
      );
    }
  }
  const reads = linkReads(t, root);
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(linked.store), true);
  assert.ok(reads.count >= 6, `each checkout's links are read (${reads.count})`);
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

test("a cache hit keeps its consumer until that consumer releases it", async (t) => {
  const { consumer } = packageFixture(t);
  const first = await installUpstreamDependencies(consumer, "current");
  const hit = await installUpstreamDependencies(consumer, "current");
  assert.equal(hit.store, first.store, "the published generation is reused");
  const marker = JSON.parse(readFileSync(join(consumer, ".basalt-dependencies.json"), "utf8"));
  assert.deepEqual(marker.links, links(join(consumer, "node_modules/.bun")));
  assert.equal(existsSync(first.store), true);
  rmSync(consumer, { recursive: true });
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(first.store), false);
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
  // The evicted key is rebuilt under its own name: one key always gives one store path (#1811).
  assert.equal(rebuilt.store, first.store);
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
  let attempt: string;
  await withCacheLock(`${locked.entry}.lock`, async () => {
    attempt = await createInstallAttempt(pending.entry);
    for (let index = 3; index <= 6; index++) key(index);
    await collectUpstreamDependencies("current");
    assert.equal(existsSync(locked.store), true);
    assert.equal(existsSync(attempt!), true);
  });
  rmSync(join(attempt!, "parent.json"));
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
  assert.equal(existsSync(attempt!), true, "format-2 input copying holds the parent key lock");
  assert.equal(existsSync(legacy.store), true);
  rmSync(`${legacy.entry}.lock`);
  await collectUpstreamDependencies("current");
  assert.equal(existsSync(attempt), false);
  assert.equal(existsSync(legacy.entry), false);
});

// #1811: one key, one store path. A store under any other name gives way once the name is free.
test("a store under another name gives way to the key's own name once that name is free", async (t) => {
  const { consumer } = packageFixture(t);
  const first = await installUpstreamDependencies(consumer, "current");
  const entry = dirname(dirname(first.store));
  assert.equal(basename(first.store), generationName(basename(entry)));
  const publish = (name: string) => {
    fs.rmSync(join(entry, "current"));
    fs.symlinkSync(join("generations", name), join(entry, "current"));
  };
  // As a store prepared before #1811 was published: under a random name.
  const random = join(entry, "generations", randomUUID());
  fs.renameSync(first.store, random);
  publish(basename(random));
  const replaced = await installUpstreamDependencies(consumer, "current");
  assert.equal(replaced.store, first.store, "the key is installed under its own name");
  assert.match(
    fs.readFileSync(join(consumer, "node_modules/is-number/index.js"), "utf8"),
    /module.exports/,
  );
  // While a broken generation holds the name, a ready store beside it stays in use: no install.
  const fallback = `${first.store}-${randomUUID()}`;
  fs.renameSync(first.store, fallback);
  fs.mkdirSync(first.store);
  publish(basename(fallback));
  const kept = await installUpstreamDependencies(consumer, "current");
  assert.equal(kept.store, fallback);
  assert.deepEqual(fs.readdirSync(join(entry, "attempts")), [], "nothing was installed");
});
