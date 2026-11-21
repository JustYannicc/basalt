import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { minimumRead, parseShard, shardEntries } from "./catalog-compat/shard.mjs";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

test("a shard argument names one of n shards; anything else is refused", () => {
  assert.deepEqual(parseShard(), { shard: 1, shards: 1 });
  assert.deepEqual(parseShard("2/3"), { shard: 2, shards: 3 });
  assert.deepEqual(parseShard("3/3"), { shard: 3, shards: 3 });
  for (const text of ["", "0/3", "4/3", "2/0", "x", "1.5/3", "2/3/4", "-1/3", " 1/3", "01/3"])
    assert.throws(() => parseShard(text), /Expected a shard like 2\/3/, JSON.stringify(text));
});

test("the shards of an index take each package exactly once, in near-equal parts", () => {
  for (let count = 0; count <= 13; count++) {
    const entries = Array.from({ length: count }, (_, index) => ({ id: `app-${index}` }));
    for (let shards = 1; shards <= 5; shards++) {
      const parts = Array.from({ length: shards }, (_, index) =>
        shardEntries(entries, { shard: index + 1, shards }),
      );
      const taken = parts.flat().map((entry) => entry.id);
      assert.deepEqual(taken.toSorted(), entries.map((entry) => entry.id).toSorted());
      assert.equal(new Set(taken).size, count);
      const sizes = parts.map((part) => part.length);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${count}/${shards}`);
    }
  }
  assert.equal(minimumRead({ shards: 1 }), 1000);
  assert.equal(minimumRead({ shards: 3 }), 333);
});

test("the catalog job's legs cover every shard once, and only the first runs the connector checks", () => {
  const job = workflow.jobs["catalog-compat"];
  const legs: number[] = job.strategy.matrix.shard;
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(
    legs,
    Array.from({ length: legs.length }, (_, index) => index + 1),
  );
  const build = job.steps.filter((step: { run?: string }) =>
    step.run?.startsWith("bun e2e/catalog-compat.mjs "),
  );
  assert.equal(build.length, 1);
  assert.equal(
    build[0].run,
    `bun e2e/catalog-compat.mjs .generated/catalog-compat/ci all 8 \${{ matrix.shard }}/${legs.length}`,
  );
  assert.equal(build[0].if, undefined);
  const checks = job.steps.filter(
    (step: { name?: string; run?: string; uses?: string }) =>
      step.name !== undefined &&
      /ElevenLabs|Zoho/.test(step.name) &&
      (step.run !== undefined || step.uses !== undefined),
  );
  assert.equal(checks.length, 4);
  for (const step of checks) assert.equal(step.if, "matrix.shard == 1", step.name);
  const upload = job.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("actions/upload-artifact"),
  );
  assert.equal(upload.with.name, "catalog-compat-evidence-${{ matrix.shard }}");
});
