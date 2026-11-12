import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { installUpstreamDependencies } from "./upstream-dependencies.ts";
import { dependencyIdentity } from "./upstream-inputs.ts";

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "basalt-private-dependencies-")));
  const consumer = join(directory, "consumer");
  const cache = join(directory, "cache");
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  process.env.BASALT_UPSTREAM_CACHE = cache;
  const run = childProcess.spawnSync;
  const probe = t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof run>) => {
    if (args[0] === "git" || args[0] === "lsof")
      return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
    return run(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    probe.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
    const removeFixture = (path: string) => {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o755);
      for (const entry of readdirSync(path, { withFileTypes: true }))
        if (entry.isDirectory()) removeFixture(join(path, entry.name));
    };
    removeFixture(directory);
    rmSync(directory, { recursive: true });
  });
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"name":"private-layout-fixture"}');
  const { key } = dependencyIdentity(consumer, "fixture-pin");
  const entry = join(cache, "prepared/fixture-pin", key);
  const store = join(entry, "generations/published");
  const bytes = join(store, "node_modules/.bun/fixture@1/node_modules/fixture");
  const index = join(store, "node_modules/.bun/node_modules");
  const scoped = join(index, "@fixture");
  mkdirSync(bytes, { recursive: true });
  mkdirSync(scoped, { recursive: true });
  writeFileSync(join(bytes, "index.js"), "synthetic package bytes");
  symlinkSync("../fixture@1/node_modules/fixture", join(index, "fixture"));
  symlinkSync("../../fixture@1/node_modules/fixture", join(scoped, "package"));
  symlinkSync(".bun/fixture@1/node_modules/fixture", join(store, "node_modules/fixture"));
  const workspace = join(consumer, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "index.js"), "private workspace source");
  chmodSync(workspace, 0o555);
  symlinkSync("../workspace", join(store, "node_modules/workspace"));
  chmodSync(join(bytes, "index.js"), 0o444);
  for (const path of [bytes, scoped, index]) chmodSync(path, 0o555);
  writeFileSync(join(store, "ready.json"), JSON.stringify({ key, trees: ["node_modules"] }));
  writeFileSync(join(entry, "store-format.json"), '{"version":3}');
  symlinkSync("generations/published", join(entry, "current"));
  return { consumer, store, index, scoped, workspace, bytes };
}

test("a second prepare replaces read-only private directories without changing shared bytes or symlink targets", async (t) => {
  const { consumer, store, index, scoped, workspace, bytes } = fixture(t);
  const first = await installUpstreamDependencies(consumer, "fixture-pin", true);
  const privateIndex = join(consumer, "node_modules/.bun/node_modules");
  const privateScope = join(privateIndex, "@fixture");
  // A checkout prepared by the previous version retains these cache directory modes.
  chmodSync(privateIndex, 0o555);
  chmodSync(privateScope, 0o555);
  const second = await installUpstreamDependencies(consumer, "fixture-pin", true);
  assert.equal(second.store, first.store);
  assert.equal(second.store, store);
  assert.equal(
    readFileSync(join(consumer, "node_modules/fixture/index.js"), "utf8"),
    "synthetic package bytes",
  );
  assert.equal(lstatSync(join(consumer, "node_modules/.bun/fixture@1")).isSymbolicLink(), true);
  for (const path of [index, scoped, bytes, workspace])
    assert.equal(
      lstatSync(path).mode & 0o777,
      0o555,
      `Shared or linked directory changed: ${path}`,
    );
  assert.equal(lstatSync(join(bytes, "index.js")).mode & 0o777, 0o444);
  assert.equal(readFileSync(join(workspace, "index.js"), "utf8"), "private workspace source");
  assert.ok(lstatSync(privateIndex).mode & 0o200);
  assert.ok(lstatSync(privateScope).mode & 0o200);
});

test("an interrupted read-only copy is removed while a linked destination stays immutable", async (t) => {
  const { consumer, store, index, workspace, bytes } = fixture(t);
  const temporary = join(consumer, "node_modules.basalt-new");
  const nested = join(temporary, "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "interrupted"), "partial copy");
  symlinkSync(workspace, join(nested, "workspace"));
  chmodSync(nested, 0o555);
  chmodSync(temporary, 0o555);
  symlinkSync(join(store, "node_modules"), join(consumer, "node_modules"));
  const installed = await installUpstreamDependencies(consumer, "fixture-pin", true);
  assert.equal(installed.store, store);
  assert.equal(existsSync(temporary), false);
  assert.equal(lstatSync(join(consumer, "node_modules")).isSymbolicLink(), false);
  for (const path of [index, workspace, bytes]) assert.equal(lstatSync(path).mode & 0o777, 0o555);
  assert.equal(
    readFileSync(join(consumer, "node_modules/fixture/index.js"), "utf8"),
    "synthetic package bytes",
  );
});
