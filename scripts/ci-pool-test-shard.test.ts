import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseShard } from "./catalog-compat/shard.ts";
import { poolTestFiles, poolTestShards } from "./ci/pool-test-shard.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const job = parse(read(".github/workflows/ci.yml")).jobs["pool-runtime"];
const contractsStep = job.steps.find(
  (step: { name?: string }) => step.name === "Check the pool runtime and database contracts",
);
// What each matrix row's contracts step lists, as the step's own command line runs it.
const listLegs = () =>
  (job.strategy.matrix.include as { shard: string; part?: string }[]).map((row) => {
    const part = row.part || "1/1";
    const files = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./ci/pool-test-shard.ts", import.meta.url)), row.shard, part],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    return { ...row, part, files };
  });

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

test("the matrix legs split each shard into parts that run each of its files exactly once", () => {
  const legs = listLegs();
  assert.equal(contractsStep.env.POOL_TEST_PART, "${{ matrix.part || '1/1' }}");
  assert.match(contractsStep.run, /pool-test-shard\.ts "\$POOL_TEST_SHARD" "\$POOL_TEST_PART"/);
  assert.deepEqual([...new Set(legs.map((leg) => leg.shard))].sort(), [...poolTestShards].sort());
  for (const shard of poolTestShards) {
    const rows = legs.filter((leg) => leg.shard === shard);
    const parts = rows.map((leg) => parseShard(leg.part));
    // Parts 1..n of one n: no part is missing or repeated.
    assert.deepEqual(
      parts.map((part) => part.shard),
      Array.from({ length: parts.length }, (_, index) => index + 1),
      shard,
    );
    assert.ok(
      parts.every((part) => part.shards === parts.length),
      shard,
    );
    const listed = rows.flatMap((leg) => leg.files);
    assert.deepEqual([...listed].sort(), poolTestFiles(root, shard), shard);
    assert.equal(new Set(listed).size, listed.length, shard);
    for (const leg of rows) assert.ok(leg.files.length > 0, `${shard} ${leg.part}`);
  }
  // The contracts step was the job's longest: it now runs in two legs.
  assert.equal(legs.filter((leg) => leg.shard === "contracts").length, 2);
  // Only the contracts legs compile the SQLite worker their files read; every leg of a shard
  // runs that shard's steps.
  const compile = job.steps.find(
    (step: { name?: string }) => step.name === "Compile and serve the SQLite upload worker assets",
  );
  assert.equal(compile.if, "matrix.shard == 'contracts'");
});
