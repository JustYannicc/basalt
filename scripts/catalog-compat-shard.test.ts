import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { minimumRead, parseShard, shardEntries } from "./catalog-compat/shard.ts";

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

test("the shards of an index take each package exactly once, and a feed change moves only itself", () => {
  const index = (count: number) => Array.from({ length: count }, (_, at) => ({ id: `app-${at}` }));
  const split = (entries: { id: string }[], shards: number) =>
    Array.from({ length: shards }, (_, at) =>
      shardEntries(entries, { shard: at + 1, shards }).map((entry) => entry.id),
    );
  for (let count = 0; count <= 13; count++)
    for (let shards = 1; shards <= 5; shards++) {
      const taken = split(index(count), shards).flat();
      assert.deepEqual(
        taken.toSorted(),
        index(count)
          .map((entry) => entry.id)
          .toSorted(),
      );
      assert.equal(new Set(taken).size, count);
    }
  // At the catalog's size the parts come out near-equal.
  const parts = split(index(1300), 3).map((part) => part.length);
  assert.ok(Math.min(...parts) > 380 && Math.max(...parts) < 490, parts.join());
  // Each leg reads the live index on its own: a package added before the others changes nobody
  // else's shard, and neither does one removed.
  const before = split(index(1300), 3);
  const added = split([{ id: "new-app" }, ...index(1300)], 3);
  const removed = split(
    index(1300).filter((entry) => entry.id !== "app-7"),
    3,
  );
  for (let at = 0; at < 3; at++) {
    assert.deepEqual(
      added[at]!.filter((id) => id !== "new-app"),
      before[at],
    );
    assert.deepEqual(
      removed[at],
      before[at]!.filter((id) => id !== "app-7"),
    );
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
