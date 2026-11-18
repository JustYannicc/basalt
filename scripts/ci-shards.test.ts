import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPaths } from "./ci/affected.ts";
import { declaredRuns, readDeclarations } from "./ci/declarations.ts";
import {
  declaredMatrices,
  estimator,
  fileDeadlineMinutes,
  planShards,
  readDeclaredDurations,
  runKey,
  shardRuns,
  shardSeconds,
  type DeclaredRun,
} from "./ci/shards.ts";

const pairs = (job: string, matrices = declaredMatrices()) =>
  matrices[job]!.include.flatMap((shard) => shardRuns(shard.runs).map(runKey));

test("every declared pair is planned into exactly one shard of its own job", () => {
  const runs = declaredRuns();
  const matrices = declaredMatrices();
  assert.deepEqual(Object.keys(matrices), Object.keys(runs));
  for (const [job, expected] of Object.entries(runs)) {
    const planned = pairs(job, matrices);
    assert.equal(new Set(planned).size, planned.length, job);
    assert.deepEqual([...planned].sort(), expected.map(runKey).sort(), job);
    const names = matrices[job]!.include.map((shard) => shard.shard);
    assert.equal(new Set(names).size, names.length, job);
  }
  assert.ok(runs["declared-self-host"]!.length > 50 && runs["declared-cloud"]!.length > 30);
});

test("shards are planned near eight minutes and each job budget covers its shard", () => {
  const durations = readDeclaredDurations();
  const estimate = estimator(durations);
  for (const [job, runs] of Object.entries(declaredRuns())) {
    const seconds = runs.map(estimate);
    const total = seconds.reduce((sum, value) => sum + value, 0);
    const shards = declaredMatrices()[job]!.include;
    assert.equal(shards.length, Math.max(1, Math.ceil(total / shardSeconds)), job);
    const loads = shards.map((shard) =>
      shardRuns(shard.runs).reduce((sum, run) => sum + estimate(run), 0),
    );
    // Longest-processing-time packing leaves no shard more than one file above the lightest.
    assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...seconds), job);
    for (const [index, shard] of shards.entries()) {
      // Covers its planned files with half again as margin, setup, and one file's own deadline.
      assert.ok(shard.timeout >= (loads[index]! / 60) * 1.5 + fileDeadlineMinutes + 3, shard.shard);
      assert.ok(shard.timeout <= 30, shard.shard);
    }
  }
});

test("planning is deterministic whatever order the pairs arrive in", () => {
  const runs = declaredRuns()["declared-cloud"]!;
  const durations = readDeclaredDurations();
  const plan = planShards("cloud", runs, durations);
  assert.deepEqual(planShards("cloud", [...runs].reverse(), durations), plan);
  assert.deepEqual(
    planShards(
      "cloud",
      [...runs].sort((a, b) => a.file.length - b.file.length || (a.file < b.file ? 1 : -1)),
      durations,
    ),
    plan,
  );
  assert.throws(() => planShards("cloud", [runs[0]!, runs[0]!], durations), /Duplicate/);
});

test("unmeasured pairs take their group's median and never break planning", () => {
  const known = { "declared:cloud a.spec.ts": 100, "declared:cloud b.spec.ts": 300 };
  const estimate = estimator({ ...known, "declared:self-host c.spec.ts": 20 });
  assert.equal(estimate({ group: "declared:cloud", file: "new.spec.ts" }), 200);
  assert.equal(estimate({ group: "declared:self-host", file: "new.spec.ts" }), 20);
  assert.equal(estimate({ group: "declared:local", file: "new.spec.ts" }), 100);
  assert.equal(estimator({})({ group: "declared:local", file: "new.spec.ts" }), 60);
  const runs: DeclaredRun[] = Array.from({ length: 20 }, (_, index) => ({
    group: "declared:cloud",
    file: `new-${index}.spec.ts`,
  }));
  const plan = planShards("cloud", runs, known);
  assert.equal(plan.length, Math.ceil((20 * 200) / shardSeconds));
  assert.deepEqual(plan.flatMap((shard) => shardRuns(shard.runs)).length, 20);
  assert.deepEqual(planShards("cloud", runs, {}).length, Math.ceil((20 * 60) / shardSeconds));
});

test("an affected selection plans only its files, in at least one shard per selected job", () => {
  const selected = selectPaths(["src/catalog/google-maps/hosted-routes.ts"]);
  const matrices = declaredMatrices(selected.declaredFiles);
  assert.deepEqual(pairs("declared-cloud", matrices), ["declared:cloud hosted-routes.spec.ts"]);
  assert.equal(matrices["declared-cloud"]!.include[0]!.shard, "declared-cloud-1");
  assert.deepEqual(matrices["declared-self-host"]!.include, []);
  const files = Object.keys(readDeclarations().files).slice(0, 30);
  const subset = declaredMatrices(files);
  const estimate = estimator(readDeclaredDurations());
  for (const [job, runs] of Object.entries(declaredRuns(files))) {
    const total = runs.map(estimate).reduce((sum, value) => sum + value, 0);
    assert.equal(subset[job]!.include.length, runs.length ? Math.ceil(total / shardSeconds) : 0);
    assert.deepEqual(pairs(job, subset).sort(), runs.map(runKey).sort(), job);
  }
  assert.deepEqual(declaredMatrices([]), {
    "declared-self-host": { include: [] },
    "declared-local": { include: [] },
    "declared-cloud": { include: [] },
  });
});

test("a shard row's run list is whole group and file pairs", () => {
  assert.deepEqual(shardRuns(" declared:cloud a.spec.ts\ndeclared:local b.spec.ts "), [
    { group: "declared:cloud", file: "a.spec.ts" },
    { group: "declared:local", file: "b.spec.ts" },
  ]);
  for (const text of ["", "declared:cloud", "declared:cloud a.spec.ts declared:local"])
    assert.throws(() => shardRuns(text), /pairs/);
  for (const file of ["a.spec.ts; true", "$(true).spec.ts", 'a".spec.ts'])
    assert.throws(
      () => planShards("declared-cloud", [{ group: "declared:cloud", file }], {}),
      /plain/,
    );
});
