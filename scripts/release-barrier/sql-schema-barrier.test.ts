import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseWorkers, type BarrierReceipt } from "./barrier.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import type { SqlSchemaReceipt } from "./sql-schema-contract.ts";
import { containerRelease } from "./test/container-fixture.ts";

const candidate = "d".repeat(40);
const manifest = {
  candidate,
  stack: "basalt",
  stage: "production",
  workers: [
    {
      id: "Api",
      accountId: "fixture",
      scriptName: "fixture-api",
      metadata: { mainModule: "main.js" },
      files: [
        {
          name: "main.js",
          type: "application/javascript+module",
          bytes: new TextEncoder().encode("export default {}"),
        },
      ],
      baseline: [{ versionId: "old", percentage: 100 }],
    },
  ],
};
function fixture(schemaReceipt = readySqlSchemas(candidate)) {
  const receipts: BarrierReceipt[] = [];
  const activated: string[] = [];
  let reads = 0;
  return {
    receipts,
    activated,
    reads: () => reads,
    options: {
      provider: {
        upload: async () => ({ versionId: "new", startupTimeMs: 1 }),
        baseline: async () => manifest.workers[0]!.baseline,
        activate: async (worker: { id: string }) => void activated.push(worker.id),
      },
      record: async (receipt: BarrierReceipt) => void receipts.push(structuredClone(receipt)),
      sqlSchemas: async (_record: (value: SqlSchemaReceipt) => Promise<void>) => {
        reads++;
        return schemaReceipt;
      },
    },
  };
}

test("Worker-only release still checks all six namespaces and persists them before activation", async () => {
  const f = fixture();
  await releaseWorkers(manifest, f.options);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.activated, ["Api"]);
  const accepted = f.receipts.find((receipt) => receipt.sqlSchemas !== undefined)!;
  assert.equal(accepted.sqlSchemas!.observations.length, 6);
  assert.deepEqual(accepted.activated, []);
});

for (const unreadable of [false, true])
  test(`${unreadable ? "unreadable" : "pending"} schema persists complete refusal receipt and prevents every activation`, async () => {
    const receipt = readySqlSchemas(candidate);
    const cloud = receipt.observations.find((entry) => entry.namespace === "cloud")!;
    cloud.expected = ["2_required"];
    cloud.status = unreadable ? "unreadable" : "pending";
    cloud.applied = unreadable ? null : ["1_old"];
    cloud.pending = unreadable ? null : ["2_required"];
    cloud.unexpected = unreadable ? null : [];
    const f = fixture(receipt);
    await assert.rejects(releaseWorkers(manifest, f.options), /cloud.*2_required/);
    assert.deepEqual(f.activated, []);
    const retained = f.receipts.at(-1)!.sqlSchemas!;
    assert.equal(retained.observations.length, 6);
    assert.deepEqual(retained.observations.find((entry) => entry.namespace === "cloud")!.expected, [
      "2_required",
    ]);
    assert.equal(f.receipts.at(-1)!.failure!.reason, "sql-schema-not-ready");
  });

test("schema assertion cannot be omitted by a caller", async () => {
  const f = fixture();
  await assert.rejects(
    releaseWorkers(manifest, { ...f.options, sqlSchemas: undefined }),
    /sql-schema-readiness-required/,
  );
  assert.deepEqual(f.activated, []);
});

// Exercise native preparation through the barrier's durable callback and activation decision.
for (const outcome of ["migrated", "failed", "noop"] as const)
  test(`native ${outcome} result reaches the persisted schema barrier before activation`, async () => {
    const { prepareHomeSchema } = await import("./home-schema-operation.ts");
    const f = fixture();
    const info = {
      format_version: 1 as const,
      target_version: 2,
      required_indexes: ["idx_usage_time"],
    };
    let current = outcome === "noop" ? 2 : 1;
    let writes = 0;
    const snapshot = () => {
      const value = readySqlSchemas(candidate);
      const home = value.observations.find((entry) => entry.namespace === "home")!;
      home.expected = ["2"];
      home.applied = [String(current)];
      home.pending = current === 2 ? [] : ["2"];
      home.status = current === 2 ? "ready" : "pending";
      value.home = undefined;
      return value;
    };
    const operation = releaseWorkers(manifest, {
      ...f.options,
      sqlSchemas: async (record) => {
        const initial = snapshot();
        const prepared = await prepareHomeSchema({
          identity: {
            candidate,
            imageDigest: initial.homeImageDigest,
            imageConfigDigest: `sha256:${"e".repeat(64)}`,
            baselineImageDigest: `sha256:${"f".repeat(64)}`,
            sourceInputHash: "a".repeat(16),
            baselineInputHash: "b".repeat(16),
          },
          info,
          admit: () => true,
          record: async (homeMigration) => {
            initial.homeMigration = homeMigration;
            await record(initial);
          },
          commands: {
            check: async () => ({
              format_version: 1,
              target_version: 2,
              previous_version: null,
              applied_version: current,
              status: current === 2 ? "ready" : "pending",
              indexes_checked: current === 2,
              pending_indexes: [],
              ...(current === 2 ? {} : { reason: "schema_pending" }),
            }),
            migrate: async (allocated) => {
              assert.equal(f.receipts.at(-1)!.sqlSchemas!.homeMigration!.state, "intent");
              await allocated?.("a".repeat(64));
              assert.equal(
                f.receipts.at(-1)!.sqlSchemas!.homeMigration!.containerId,
                "a".repeat(64),
              );
              assert.deepEqual(f.activated, []);
              writes++;
              if (outcome === "failed")
                return {
                  format_version: 1,
                  target_version: 2,
                  previous_version: 1,
                  applied_version: 1,
                  status: "failed",
                  indexes_checked: false,
                  pending_indexes: [],
                  reason: "migration_failed",
                  sqlstate: "42501",
                };
              current = 2;
              return {
                format_version: 1,
                target_version: 2,
                previous_version: 1,
                applied_version: 2,
                status: "migrated",
                indexes_checked: true,
                pending_indexes: [],
              };
            },
          },
        });
        return { ...snapshot(), home: prepared.proof, homeMigration: prepared.receipt };
      },
    });
    if (outcome === "failed")
      await assert.rejects(operation, /home.*required=2.*migration=failed.*migration_failed/);
    else await operation;
    assert.equal(writes, outcome === "noop" ? 0 : 1);
    assert.deepEqual(f.activated, outcome === "failed" ? [] : ["Api"]);
    const retained = f.receipts.at(-1)!.sqlSchemas!;
    assert.equal(retained.observations.length, 6);
    assert.equal(retained.homeMigration!.state, outcome === "noop" ? "skipped" : outcome);
    assert.equal(retained.homeMigration!.after!.applied_version, outcome === "failed" ? 1 : 2);
  });

test("a changed-image release refuses a schema proof from another Home image before any activation", async () => {
  const f = containerRelease();
  const wrong = readySqlSchemas(f.manifest.candidate);
  assert.notEqual(wrong.homeImageDigest, f.frozen.imageDigest);
  await assert.rejects(
    releaseWorkers(f.manifest, { ...f.options, sqlSchemas: async () => wrong }),
    /home-schema-candidate-image-mismatch.*home required-image=sha256:.*observed-image=sha256:/,
  );
  assert.deepEqual(f.receipts.at(-1)!.activated, []);
  assert.equal(f.receipts.at(-1)!.sqlSchemas!.homeImageDigest, wrong.homeImageDigest);
  assert.ok(!f.events.some((event) => event.startsWith("container:")));
});
