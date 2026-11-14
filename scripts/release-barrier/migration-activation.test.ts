import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationActivationIntent, runMigrationActivation } from "./migration-activation.ts";
import { releaseOperationFingerprint } from "./release-operation.ts";
import type {
  MigrationActivationPorts,
  MigrationActivationReceipt,
} from "./migration-activation-contract.ts";

const candidate = "a".repeat(40);
const hash = "b".repeat(64);
function fixture() {
  const snapshot = {
    candidate,
    sourceFingerprint: hash,
    readers: {
      release: { candidate, deploymentId: 42, receiptDigest: hash },
      workers: (["Api", "AppPages", "PoolWorker"] as const).map((role) => ({
        role,
        target: hash,
        versionId: `${role}-version`,
        acceptedVersionId: `${role}-version`,
        percentage: 100,
      })),
      poolAdoption: { candidate, poolWorkerRevision: hash, imageInput: hash },
      apps: { count: 4, fingerprint: hash },
    },
    hosted: { prepared: true, active: false, fingerprint: hash },
    pool: {
      prepared: true,
      active: false,
      schemaHash: hash,
      catalogHash: hash,
      report: { automaticBackfill: false, readersReadyRequired: "checkpoint-count-v1" },
    },
  };
  let receipt: MigrationActivationReceipt | undefined;
  let sends = 0;
  let writes = 0;
  let active = false;
  const ports: MigrationActivationPorts = {
    read: async () => structuredClone(snapshot),
    load: async () => receipt,
    save: async (value) => {
      writes++;
      receipt = structuredClone(value);
    },
    activate: async () => {
      sends++;
      assert.equal(receipt?.sent, true);
      active = true;
    },
    inspect: async () => ({
      status: active ? "complete" : "pending",
      result: { hosted: active ? "active" : "prepared", pool: active ? "active" : "prepared" },
    }),
  };
  return { snapshot, ports, counts: () => ({ sends, writes }) };
}

test("activation plans and inspects are read-only; one reviewed digest activates both targets once", async () => {
  const f = fixture();
  const plan = await runMigrationActivation({ candidate, mode: "plan", ports: f.ports });
  assert.equal(plan.intent.contract, "checkpoint-count-v1");
  assert.deepEqual(plan.intent.targets, [
    "22_change_journal_activate",
    "model_request_history_v10_change_journal_activate",
  ]);
  assert.deepEqual(f.counts(), { sends: 0, writes: 0 });
  const inspected = await runMigrationActivation({ candidate, mode: "inspect", ports: f.ports });
  assert.equal(inspected.status, "pending");
  assert.deepEqual(f.counts(), { sends: 0, writes: 0 });
  const complete = await runMigrationActivation({
    candidate,
    mode: plan.fingerprint,
    ports: f.ports,
  });
  assert.equal(complete.status, "complete");
  await runMigrationActivation({ candidate, mode: plan.fingerprint, ports: f.ports });
  await runMigrationActivation({ candidate, mode: "inspect", ports: f.ports });
  assert.equal(f.counts().sends, 1);
});

test("a changed app inventory makes the reviewed digest stale before any activation", async () => {
  const f = fixture();
  const plan = await runMigrationActivation({ candidate, mode: "plan", ports: f.ports });
  const changed = structuredClone(f.snapshot);
  changed.readers.apps = { count: 5, fingerprint: "c".repeat(64) };
  f.ports.read = async () => changed;
  await assert.rejects(
    runMigrationActivation({ candidate, mode: plan.fingerprint, ports: f.ports }),
    /migration-activation-plan-stale/,
  );
  assert.deepEqual(f.counts(), { sends: 0, writes: 0 });
});

test("reader retirement requires every actual serving role and the adopted singleton", () => {
  for (const role of ["Api", "AppPages", "PoolWorker"] as const) {
    const f = fixture();
    const changed = structuredClone(f.snapshot);
    changed.readers.workers = changed.readers.workers.map((worker) =>
      worker.role === role ? { ...worker, percentage: 90 } : worker,
    );
    assert.throws(() => migrationActivationIntent(candidate, changed), /readers-not-retired/);
  }
  const f = fixture();
  const changed = structuredClone(f.snapshot);
  changed.readers.poolAdoption = { ...changed.readers.poolAdoption, candidate: "c".repeat(40) };
  assert.throws(() => migrationActivationIntent(candidate, changed), /reader-adoption-missing/);
});

test("the exact candidate, preparations and already-active state cannot be replaced by an acknowledgement", () => {
  const f = fixture();
  assert.throws(() => migrationActivationIntent("c".repeat(40), f.snapshot), /candidate-mismatch/);
  for (const namespace of ["hosted", "pool"] as const) {
    const changed = { ...f.snapshot, [namespace]: { ...f.snapshot[namespace], prepared: false } };
    assert.throws(() => migrationActivationIntent(candidate, changed), /not-prepared/);
    const active = { ...f.snapshot, [namespace]: { ...f.snapshot[namespace], active: true } };
    assert.throws(() => migrationActivationIntent(candidate, active), /already-active/);
  }
  const changed = structuredClone(f.snapshot);
  changed.hosted = { ...changed.hosted, active: true };
  changed.pool = { ...changed.pool, active: true };
  assert.throws(() => migrationActivationIntent(candidate, changed), /already-active/);
});

test("a lost activation reply stays pending and later inspection never sends again", async () => {
  const f = fixture();
  const intent = migrationActivationIntent(candidate, f.snapshot);
  const fingerprint = releaseOperationFingerprint(candidate, intent);
  f.ports.activate = async () => {
    throw new Error("synthetic lost reply");
  };
  const pending = await runMigrationActivation({ candidate, mode: fingerprint, ports: f.ports });
  assert.equal(pending.status, "pending");
  assert.equal(pending.sent, true);
  f.ports.read = async () => {
    throw new Error("sent intents must not be replanned");
  };
  const writes = f.counts().writes;
  await runMigrationActivation({ candidate, mode: "inspect", ports: f.ports });
  assert.equal(f.counts().writes, writes);
  await runMigrationActivation({ candidate, mode: fingerprint, ports: f.ports });
  assert.equal(f.counts().writes, writes);
});
