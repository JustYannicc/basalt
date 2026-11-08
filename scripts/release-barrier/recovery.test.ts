import { placementRepairTargets } from "./pending-placement.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverWorkers, type RecoveryReceipt, type RecoveryWorker } from "./recovery.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";

function fixture() {
  const workers = ["Api", "PoolWorker", "Router"].map((id) => ({
    id,
    target: digest(id),
    metadata: digest("metadata"),
    files: [{ name: "main.js", type: "module", bytes: 1, sha256: digest("bytes") }],
    baseline: [{ versionId: `old-${id}`, percentage: 100 }],
  }));
  const manifest = { candidate: "a".repeat(40), stack: "basalt", stage: "production", workers };
  const receipt = {
    schemaVersion: 1,
    candidate: manifest.candidate,
    manifest: digest(canonical(manifest)),
    accepted: workers.map((worker) => ({
      worker: worker.id,
      versionId: `accepted-${worker.id}`,
      startupTimeMs: 100,
    })),
  };
  const active = new Map(
    workers.map((worker) => [worker.id, [{ versionId: `accepted-${worker.id}`, percentage: 100 }]]),
  );
  const calls: string[] = [],
    receipts: RecoveryReceipt[] = [];
  const provider = {
    async read(worker: RecoveryWorker) {
      return { target: worker.target, versions: active.get(worker.id)! };
    },
    async restore(worker: RecoveryWorker) {
      calls.push(worker.id);
      active.set(
        worker.id,
        worker.baseline.map((version) => ({ ...version })),
      );
    },
  };
  return {
    workers,
    manifest,
    receipt,
    active,
    calls,
    receipts,
    provider,
    async record(value: RecoveryReceipt) {
      receipts.push(value);
    },
  };
}

test("one recorded recovery restores exact baseline IDs and reconciles already completed calls", async () => {
  const proof = fixture();
  proof.active.set("Router", proof.workers[2]!.baseline);
  const result = await recoverWorkers(proof.manifest, proof.receipt, proof.provider, proof.record);
  assert.deepEqual(proof.calls, ["PoolWorker", "Api"]);
  assert.deepEqual(result.restored, proof.calls);
  assert.deepEqual(
    [...proof.active.values()],
    proof.workers.map((worker) => worker.baseline),
  );
  proof.calls.length = 0;
  await recoverWorkers(proof.manifest, proof.receipt, proof.provider, proof.record);
  assert.deepEqual(proof.calls, []);
});

test("unrecognized live deployment or target drift refuses before the first recovery write", async () => {
  const proof = fixture();
  proof.active.set("Router", [{ versionId: "outside-version", percentage: 100 }]);
  await assert.rejects(
    recoverWorkers(proof.manifest, proof.receipt, proof.provider, proof.record),
    /recovery-deployment-drift/,
  );
  assert.deepEqual(proof.calls, []);
  await assert.rejects(
    recoverWorkers(
      proof.manifest,
      proof.receipt,
      {
        ...proof.provider,
        async read(worker) {
          return { target: "wrong", versions: worker.baseline };
        },
      },
      proof.record,
    ),
    /recovery-target-drift/,
  );
  assert.deepEqual(proof.calls, []);
});

test("10220 is retained as a secret transition refusal; recovery never silently forces or retries", async () => {
  const proof = fixture();
  const refusal = {
    ...proof.provider,
    async restore(worker: RecoveryWorker) {
      proof.calls.push(worker.id);
      throw new BarrierRefusal("secret-change-refuses-rollback", worker.id);
    },
  };
  await assert.rejects(
    recoverWorkers(proof.manifest, proof.receipt, refusal, proof.record),
    /secret-change-refuses-rollback/,
  );
  assert.deepEqual(proof.calls, ["Router"]);
  assert.deepEqual(proof.receipts.at(-1), {
    candidate: proof.manifest.candidate,
    manifest: proof.receipt.manifest,
    restored: [],
    pending: "Router",
    failure: "secret-change-refuses-rollback",
  });
});

test("a changed frozen manifest cannot authorize rollback", async () => {
  const proof = fixture();
  proof.manifest.workers[0]!.baseline[0]!.versionId = "different";
  await assert.rejects(
    recoverWorkers(proof.manifest, proof.receipt, proof.provider, proof.record),
    /recovery-receipt-mismatch/,
  );
  assert.deepEqual(proof.calls, []);
});

for (const target of placementRepairTargets)
  test(`recovery refuses the known damaged ${target.role} version before any restore`, async () => {
    const f = fixture();
    f.workers[0]!.id = target.role;
    f.workers[0]!.baseline = [{ versionId: target.version, percentage: 100 }];
    f.receipt.manifest = digest(canonical(f.manifest));
    let reads = 0,
      containerWrites = 0;
    await assert.rejects(
      recoverWorkers(
        f.manifest,
        f.receipt,
        {
          ...f.provider,
          read: async (worker) => {
            reads++;
            return f.provider.read(worker);
          },
        },
        f.record,
        async () => {
          containerWrites++;
        },
      ),
      /damaged-placement-version-rollback-refused/,
    );
    assert.equal(reads, 0);
    assert.equal(containerWrites, 0);
    assert.deepEqual(f.calls, []);
  });
