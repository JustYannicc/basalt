import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRuntimeRecovery, RuntimeRecovery, runtimeRecoveryPrefix, type RecoveryApproval, type RecoveryReceipt } from "./runtime-recovery.ts";
import { signEnvelope } from "./token.ts";

const secret = "ab".repeat(32);
function fixture() {
  const values = new Map<string, RecoveryReceipt>();
  let restarts = 0;
  const runtime = { instanceId: "a".repeat(64), imageHash: "synthetic-image", running: () => true,
    status: async () => { throw new Error("synthetic private health failure"); },
    restart: async () => { restarts++; return { boot_id: "new-boot", started_at: "2026-11-04T00:00:00Z" }; } };
  const storage = { get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: RecoveryReceipt) => { values.set(key, structuredClone(value)); } };
  const recovery = new RuntimeRecovery(runtime, storage);
  const approval: RecoveryApproval = { version: 1, action: "restart", operationId: crypto.randomUUID(),
    instanceId: runtime.instanceId, imageHash: runtime.imageHash, at: Date.now(), expiresAt: Date.now() + 60_000 };
  return { values, runtime, storage, recovery, approval, restarts: () => restarts };
}

test("inspection never warms an unhealthy runtime; exact signed restart retains an idempotent receipt", async () => {
  const f = fixture();
  assert.equal((await f.recovery.inspect()).ready, false);
  assert.equal(f.restarts(), 0);
  const [first, duplicate] = await Promise.all([f.recovery.run(f.approval), f.recovery.run(f.approval)]);
  assert.equal(first.status, "ready");
  assert.deepEqual(duplicate, first);
  assert.equal(f.restarts(), 1);
  const evicted = new RuntimeRecovery(f.runtime, f.storage);
  assert.deepEqual(await evicted.run(f.approval), first);
  assert.deepEqual((await evicted.inspect(f.approval.operationId)).receipt, first);
  assert.equal(f.restarts(), 1);
});

test("a started receipt is durable before destruction, and an unknown or failed result never repeats it", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    let calls = 0;
    f.runtime.restart = async () => {
      calls++;
      assert.equal((await f.recovery.inspect(f.approval.operationId)).receipt?.status, "started");
      throw new Error("private-response-sentinel");
    };
    const put = f.storage.put;
    if (fail) f.storage.put = async (key, receipt) => {
      if (receipt.status !== "started") throw new Error("lost receipt write");
      await put(key, receipt);
    };
    const result = f.recovery.run(f.approval);
    if (fail) await assert.rejects(result, /lost receipt write/);
    else assert.equal((await result).status, "failed");
    const receipt = await new RuntimeRecovery(f.runtime, f.storage).run(f.approval);
    assert.equal(receipt.status, fail ? "started" : "failed");
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(receipt).includes("private-response-sentinel"));
  }
});

test("a changed instance, changed image or failed audit refuses before a restart", async () => {
  for (const change of ["instanceId", "imageHash"] as const) {
    const f = fixture();
    await assert.rejects(f.recovery.run({ ...f.approval, [change]: "different" }));
    assert.equal(f.restarts(), 0);
    assert.equal(f.values.size, 0);
  }
  const f = fixture();
  f.storage.put = async () => { throw new Error("audit unavailable"); };
  await assert.rejects(f.recovery.run(f.approval), /audit unavailable/);
  assert.equal(f.restarts(), 0);
});

test("the private HTTP operation requires a short-lived recovery signature and retains safe failures", async () => {
  const f = fixture();
  const service = { inspectRuntimeRecovery: (id?: string) => f.recovery.inspect(id),
    recoverRuntime: (approval: RecoveryApproval) => f.recovery.run(approval) };
  const post = async (value: unknown, prefix = runtimeRecoveryPrefix, key = secret) => handleRuntimeRecovery(
    new Request("https://operator/runtime-recovery", { method: "POST", body: JSON.stringify({ envelope: await signEnvelope(key, prefix, value) }) }),
    service, secret);
  for (const [value, prefix, key] of [
    [f.approval, runtimeRecoveryPrefix, "cd".repeat(32)],
    [f.approval, "sbp1", secret],
    [{ ...f.approval, expiresAt: Date.now() - 1 }, runtimeRecoveryPrefix, secret],
    [{ ...f.approval, expiresAt: Date.now() + 120_000 }, runtimeRecoveryPrefix, secret],
  ] as const) assert.equal((await post(value, prefix, key)).status, 401);
  assert.equal(f.restarts(), 0);
  assert.equal((await post({ ...f.approval, instanceId: "b".repeat(64) })).status, 409);
  const response = await post(f.approval);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ready");
  assert.equal(f.restarts(), 1);
  const read = await handleRuntimeRecovery(new Request(`https://operator/runtime-recovery?operationId=${f.approval.operationId}`), service, secret);
  assert.equal((await read.json()).receipt.status, "ready");
  assert.equal(f.restarts(), 1);
});
