import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRecovery, handleRuntimeRecovery } from "../src/pool/runtime-recovery.ts";
import { automaticRecoveryAuthority } from "../src/pool/automatic-authority.ts";
import {
  automaticOperationId,
  automaticTargetDigest,
  collectAutomaticEvidence,
  reviewedAutomaticTarget,
  type AutomaticTarget,
} from "./runtime-recovery/automatic.ts";
import { runReviewedRecovery } from "./runtime-recovery/run.ts";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const target: AutomaticTarget = {
  version: 1,
  pool: "synthetic-pool",
  accountId: "a".repeat(32),
  worker: "synthetic-worker",
  deploymentId: id(1),
  workerVersion: id(2),
  release: "b".repeat(40),
  applicationId: id(3),
  applicationVersion: 29,
  imageDigest: `sha256:${"c".repeat(64)}`,
  resources: { instanceType: "basic", vcpu: 0.25, memoryMiB: 1024, diskMiB: 4000, maxInstances: 1 },
  instanceId: "d".repeat(64),
  imageHash: "e".repeat(16),
  bootId: id(4),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "automatic-runtime-"));
  const { pool: _pool, ...pins } = target;
  const selection = automaticTargetDigest(target);
  const plan = { ...pins, operationId: automaticOperationId("1234", selection) };
  let clock = Date.now() - 120_000;
  let boot = target.bootId;
  let stops = 0,
    posts = 0,
    observations = 0;
  const mode = { condition: "view-transport", enabled: true, lostReply: false, drift: false };
  const records = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => structuredClone(records.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value));
    },
  };
  const runtime = {
    instanceId: target.instanceId,
    imageHash: target.imageHash,
    release: target.release,
    running: () => true,
    status: async () => ({ boot_id: boot, started_at: "2026-11-09T00:00:00Z" }),
    restart: async (guard?: () => Promise<void>) => {
      await guard?.();
      stops++;
      boot = id(5);
      return runtime.status();
    },
  };
  const recovery = new RuntimeRecovery(
    runtime,
    storage,
    Date.now,
    automaticRecoveryAuthority(storage, target.pool, async () => mode.condition),
  );
  const operations = {
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/automatic-recovery-observation") {
        assert.equal(request.method, "GET");
        observations++;
        return Response.json({
          enabled: mode.enabled,
          runtime: await recovery.inspect(),
          condition: mode.condition,
        });
      }
      if (request.method === "POST") posts++;
      const response = await handleRuntimeRecovery(
        request,
        {
          inspectRuntimeRecovery: (operation) => recovery.inspect(operation),
          recoverRuntime: (approval) => recovery.run(approval),
        },
        "ab".repeat(32),
      );
      if (request.method === "POST" && mode.lostReply) throw new Error("private-response-sentinel");
      return response;
    },
  };
  const provider = async () => ({
    applicationId: target.applicationId,
    applicationVersion: mode.drift ? 30 : target.applicationVersion,
    imageDigest: target.imageDigest,
    resources: target.resources,
    instanceId: target.instanceId,
    deploymentId: target.deploymentId,
    workerVersion: target.workerVersion,
  });
  const deps = { operations, provider, directory, signingKey: "ab".repeat(32) };
  const collect = () =>
    collectAutomaticEvidence(target, plan, {
      ...deps,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  return {
    plan,
    deps,
    collect,
    mode,
    records,
    stops: () => stops,
    posts: () => posts,
    observations: () => observations,
    clean: () => rm(directory, { recursive: true, force: true }),
  };
}

test("reviewed automatic target binds every pin; reruns derive the same operation", () => {
  const digest = automaticTargetDigest(target);
  assert.deepEqual(reviewedAutomaticTarget(JSON.stringify(target), digest), target);
  assert.throws(
    () => reviewedAutomaticTarget(JSON.stringify({ ...target, applicationVersion: 30 }), digest),
    /target-invalid/,
  );
  assert.throws(
    () => reviewedAutomaticTarget(JSON.stringify({ ...target, extra: true }), digest),
    /target-invalid/,
  );
  assert.equal(automaticOperationId("1234", digest), automaticOperationId("1234", digest));
  assert.notEqual(automaticOperationId("1235", digest), automaticOperationId("1234", digest));
});

test("three read-only observations feed one signed restart through the actual reviewed HTTP route", async () => {
  const f = await fixture();
  try {
    const evidence = await f.collect();
    assert.equal(f.observations(), 3);
    assert.equal(f.records.size, 0);
    assert.equal(f.posts(), 0);
    const result = await runReviewedRecovery(f.plan, "apply", { ...f.deps, automatic: evidence });
    assert.equal(result.outcome, "ready");
    assert.equal(f.posts(), 1);
    assert.equal(f.stops(), 1);
    assert.equal((await runReviewedRecovery(f.plan, "inspect", f.deps)).outcome, "inspection");
    assert.equal(f.posts(), 1);
  } finally {
    await f.clean();
  }
});

test("lost replies inspect the same receipt and never submit another automatic restart", async () => {
  const f = await fixture();
  try {
    const evidence = await f.collect();
    f.mode.lostReply = true;
    const result = await runReviewedRecovery(f.plan, "apply", { ...f.deps, automatic: evidence });
    assert.equal(result.outcome, "inspection");
    assert.equal(result.receipt?.status, "ready");
    assert.equal(f.posts(), 1);
    await runReviewedRecovery(f.plan, "apply", { ...f.deps, automatic: evidence });
    assert.equal(f.posts(), 1);
    assert.equal(f.stops(), 1);
  } finally {
    await f.clean();
  }
});

test("disabled targets, policy faults, recovery and provider drift stop collection without a POST", async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.mode.enabled = false;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.mode.condition = "policy-invalid";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.mode.condition = "healthy";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.mode.drift = true;
    },
  ]) {
    const f = await fixture();
    try {
      change(f);
      await assert.rejects(f.collect());
      assert.equal(f.posts(), 0);
      assert.equal(f.stops(), 0);
      assert.equal(f.records.size, 0);
    } finally {
      await f.clean();
    }
  }
});
