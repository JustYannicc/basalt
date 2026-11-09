import assert from "node:assert/strict";
import { test } from "node:test";
import { automaticRecoveryAuthority } from "./automatic-authority.ts";
import {
  RuntimeRecovery,
  handleRuntimeRecovery,
  runtimeRecoveryPrefix,
} from "./runtime-recovery.ts";
import type { AutomaticApproval } from "./recovery-approval.ts";
import { signEnvelope } from "./token.ts";

function fixture() {
  let at = Date.now();
  let boot = crypto.randomUUID();
  let stops = 0;
  let condition = "view-transport";
  let enabled = "synthetic-pool";
  const records = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => structuredClone(records.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value));
    },
  };
  const runtime = {
    instanceId: "a".repeat(64),
    imageHash: "b".repeat(16),
    release: "c".repeat(40),
    running: () => true,
    status: async () => ({ boot_id: boot, started_at: "2026-11-09T00:00:00Z" }),
    restart: async (guard?: () => Promise<void>) => {
      await guard?.();
      assert.ok(
        [...records.values()].some(
          (v) => v && typeof v === "object" && "status" in v && v.status === "started",
        ),
      );
      stops++;
      boot = crypto.randomUUID();
      return runtime.status();
    },
  };
  const construct = () =>
    new RuntimeRecovery(
      runtime,
      storage,
      () => at,
      automaticRecoveryAuthority(
        storage,
        enabled,
        async () => condition,
        () => at,
      ),
    );
  const recovery = construct();
  const approval = (): AutomaticApproval => ({
    version: 1,
    action: "restart-automatic",
    operationId: crypto.randomUUID(),
    instanceId: runtime.instanceId,
    imageHash: runtime.imageHash,
    release: runtime.release,
    bootId: boot,
    at,
    expiresAt: at + 60_000,
    pool: "synthetic-pool",
    selection: "d".repeat(64),
    samples: [at - 120_000, at - 60_000, at].map((time) => ({
      at: time,
      selection: "d".repeat(64),
      condition: "view-transport",
    })),
  });
  const call = async (value: AutomaticApproval, owner = recovery) =>
    handleRuntimeRecovery(
      new Request("http://pool/runtime-recovery", {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope("ab".repeat(32), runtimeRecoveryPrefix, value),
        }),
      }),
      {
        inspectRuntimeRecovery: (id) => owner.inspect(id),
        recoverRuntime: (input) => owner.run(input),
      },
      "ab".repeat(32),
    );
  return {
    approval,
    recovery,
    construct,
    call,
    runtime,
    storage,
    records,
    stops: () => stops,
    condition: (value: string) => {
      condition = value;
    },
    enabled: (value: string) => {
      enabled = value;
    },
    advance: (ms: number) => {
      at += ms;
    },
    changeBoot: () => {
      boot = crypto.randomUUID();
    },
  };
}

test("signed automatic restart records its durable budget and receipt before stopping, then replays", async () => {
  const f = fixture();
  const approval = f.approval();
  const result = await f.call(approval);
  assert.equal(result.status, 200);
  const receipt = await result.json();
  assert.equal(receipt.status, "ready");
  assert.notEqual(receipt.bootId, approval.bootId);
  assert.equal(f.stops(), 1);
  assert.equal((await f.call(approval, f.construct())).status, 200);
  assert.equal(f.stops(), 1);
  await assert.rejects(f.construct().run(f.approval()), /cooldown/);
  assert.equal(f.stops(), 1);
});

test("a disabled target, recovered view, policy fault or changed boot refuses before any destruction", async () => {
  for (const condition of ["healthy", "policy-invalid", "unknown", "stopped", "unready"]) {
    const f = fixture();
    f.condition(condition);
    assert.equal((await f.call(f.approval())).status, 409);
    assert.equal(f.stops(), 0);
    assert.equal(f.records.size, 0);
  }
  const f = fixture();
  f.enabled("");
  assert.equal((await f.call(f.approval(), f.construct())).status, 403);
  const old = f.approval();
  f.changeBoot();
  assert.equal((await f.call(old)).status, 409);
  assert.equal(f.stops(), 0);
});

test("stale evidence and invalid selection refuse even with a healthy current boot", async () => {
  for (const change of [
    (a: AutomaticApproval) => ({
      ...a,
      samples: a.samples.map((s, i) => (i === 2 ? { ...s, at: s.at - 31_000 } : s)),
    }),
    (a: AutomaticApproval) => ({ ...a, selection: "e".repeat(64) }),
    (a: AutomaticApproval) => ({
      ...a,
      samples: a.samples.map((s, i) =>
        i === 1 ? { ...s, condition: "policy-invalid" as const } : s,
      ),
    }),
  ]) {
    const f = fixture();
    const value = change(f.approval());
    assert.equal((await f.call(value)).status, 409);
    assert.equal(f.stops(), 0);
  }
});

test("a lost started-receipt write leaves the automatic attempt consumed across reconstruction", async () => {
  const f = fixture();
  const put = f.storage.put;
  f.storage.put = async (key, value) => {
    if (key !== "runtime-recovery-v1:automatic-budget")
      throw new Error("receipt write unavailable");
    return put(key, value);
  };
  const value = f.approval();
  assert.equal((await f.call(value)).status, 503);
  assert.equal(f.records.has(`runtime-recovery-v1:${value.operationId}`), false);
  f.storage.put = put;
  f.advance(31 * 60_000);
  await assert.rejects(f.construct().run(f.approval()), /uncertain/);
  assert.equal(f.stops(), 0);
});
