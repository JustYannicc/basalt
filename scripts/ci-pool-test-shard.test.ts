import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { poolTestFiles } from "./ci/pool-test-shard.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the two pool-runtime shards run every pool test file exactly once", () => {
  const contracts = poolTestFiles(root, "contracts");
  const compatibility = poolTestFiles(root, "compatibility");
  const all = readdirSync(new URL("./pool-tests/", import.meta.url))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `scripts/pool-tests/${file}`)
    .sort();
  assert.deepEqual([...contracts, ...compatibility].sort(), all);
  assert.equal(new Set([...contracts, ...compatibility]).size, all.length);
  assert.ok(contracts.length > compatibility.length && compatibility.length > 0);
  // A file that reads a compatibility image would fail where those images are never loaded.
  for (const file of contracts)
    assert.doesNotMatch(
      readFileSync(new URL("../" + file, import.meta.url), "utf8"),
      /POOL_TEST_(?:LEGACY|USAGE_PRIVACY|BASE)_IMAGE/,
      file,
    );
});
