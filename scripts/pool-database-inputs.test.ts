import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  poolDatabaseCommandSources,
  poolDatabaseInputs,
} from "../src/pool/model-history/sources.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the pool database command's key is every file the command runs", () => {
  // Packages are covered by the lockfile, which the key also holds. Everything else the command
  // loads is a relative import, followed here from its entry.
  const seen = new Set<string>();
  const pending = [resolve(root, "scripts/ensure-pool-database.ts")];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/gu,
    )) {
      if (!/^\.{1,2}\//u.test(specifier!)) continue;
      const target = resolve(dirname(file), specifier!);
      assert.ok(existsSync(target), `${relative(root, file)} imports ${specifier}`);
      pending.push(target);
    }
  }
  // A file missing from the key would let a release skip the command although its statements
  // changed. A file that is listed but no longer run would re-run it for nothing.
  assert.deepEqual(
    [...seen].map((file) => relative(root, file).replaceAll("\\", "/")).sort(),
    [...poolDatabaseCommandSources].sort(),
  );
});

test("the key names those files from the directory the command runs in", () => {
  assert.equal(poolDatabaseInputs.lockfile, true);
  assert.deepEqual(
    poolDatabaseInputs.include.map((path) => relative(root, resolve(root, "scripts", path))).sort(),
    [...poolDatabaseCommandSources].sort(),
  );
  for (const path of poolDatabaseInputs.include)
    assert.ok(existsSync(resolve(root, "scripts", path)), `${path} does not exist`);
});
