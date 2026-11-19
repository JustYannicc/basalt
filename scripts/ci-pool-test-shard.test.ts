import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { poolTestFiles } from "./ci/pool-test-shard.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

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
  // The contracts shard never loads the compatibility images, so none of its files may read the
  // variables the workflow points at them.
  const loaded = [
    ...read(".github/actions/pool-compatibility-images/action.yml").matchAll(/--tag (\S+)/g),
  ].map((match) => match[1]);
  const contractsStep = parse(read(".github/workflows/ci.yml")).jobs["pool-runtime"].steps.find(
    (step: { name?: string }) => step.name === "Check the pool runtime and database contracts",
  );
  const variables = Object.entries<string>(contractsStep.env)
    .filter(([, value]) => loaded.includes(value))
    .map(([name]) => name);
  assert.ok(variables.length >= 2, "the contracts step names the compatibility images");
  for (const file of contracts)
    for (const variable of variables)
      assert.ok(!read(file).includes(variable), file + " " + variable);
  for (const variable of variables)
    assert.ok(
      compatibility.some((file) => read(file).includes(variable)),
      variable,
    );
});
