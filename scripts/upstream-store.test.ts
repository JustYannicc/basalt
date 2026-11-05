import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { installUpstreamDependencies } from "./upstream-dependencies.ts";
import { collectUpstreamDependencies } from "./upstream-store.ts";

test("failed installs and unused generations are collected without losing installed consumers", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "basalt-store-collection-"));
  const variables = ["BASALT_UPSTREAM_CACHE", "BUN_INSTALL_CACHE_DIR", "FIXTURE_INSTALL_FAIL"];
  const previous = new Map(variables.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of variables) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const writable = (directory: string) => {
      chmodSync(directory, 0o755);
      for (const entry of readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) writable(join(directory, entry.name));
    };
    writable(fixture);
    rmSync(fixture, { recursive: true });
  });
  const root = join(fixture, "consumer"),
    cache = join(fixture, "cache");
  mkdirSync(root);
  process.env.BASALT_UPSTREAM_CACHE = cache;
  process.env.BUN_INSTALL_CACHE_DIR = join(fixture, "bun-cache");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "collection-fixture",
      dependencies: { "is-number": "7.0.0" },
      scripts: {
        prepare: `node -e 'process.exit(process.env.FIXTURE_INSTALL_FAIL === "1" ? 1 : 0)'`,
      },
    }),
  );
  writeFileSync(join(root, "bunfig.toml"), '[install]\nlinker = "isolated"\n');
  execFileSync("bun", ["install", "--ignore-scripts", "--backend=copyfile"], {
    cwd: root,
    stdio: "pipe",
  });
  process.env.FIXTURE_INSTALL_FAIL = "1";
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(installUpstreamDependencies(root, "fixture-pin"));
  const pin = join(cache, "prepared/fixture-pin");
  const entries = readdirSync(pin)
    .filter((name) => !name.endsWith(".lock"))
    .map((name) => join(pin, name));
  assert.equal(
    entries.some((path) => path.includes(".attempt-")),
    false,
  );
  for (const entry of entries) assert.deepEqual(readdirSync(join(entry, "attempts")), []);
  delete process.env.FIXTURE_INSTALL_FAIL;
  let result = await installUpstreamDependencies(root, "fixture-pin");
  const entry = dirname(dirname(result.store));
  const retired: string[] = [];
  for (let recovery = 0; recovery < 3; recovery++) {
    retired.push(result.store);
    writeFileSync(join(result.store, "ready.json"), "{");
    result = await installUpstreamDependencies(root, "fixture-pin");
  }
  await collectUpstreamDependencies();
  assert.equal(readdirSync(join(entry, "generations")).length, 1);
  assert.equal(retired.some(existsSync), false);
  assert.equal(
    JSON.parse(readFileSync(join(root, ".basalt-dependencies.json"), "utf8")).store,
    result.store,
  );
  const concurrent = await Promise.all([
    installUpstreamDependencies(root, "fixture-pin-a"),
    installUpstreamDependencies(root, "fixture-pin-b"),
  ]);
  result = concurrent[1]!;
  assert.equal(
    readFileSync(join(root, "node_modules/is-number/index.js"), "utf8"),
    readFileSync(join(result.store, "node_modules/is-number/index.js"), "utf8"),
  );
  rmSync(root, { recursive: true });
  await collectUpstreamDependencies();
  assert.equal(existsSync(result.store), false, "removed consumers no longer pin package bytes");
});
