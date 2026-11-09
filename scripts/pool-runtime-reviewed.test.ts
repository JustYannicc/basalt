import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuntimeRecovery,
  handleRuntimeRecovery,
  type RecoveryReceipt,
} from "../src/pool/runtime-recovery.ts";
import { providerPins } from "./runtime-recovery/inventory.ts";
import {
  recoveryPlanDigest,
  reviewedPlan,
  RecoveryWorkflowRefusal,
  type RecoveryPlan,
} from "./runtime-recovery/plan.ts";
import { recordRecoveryIssue, runReviewedRecovery } from "./runtime-recovery/run.ts";
import { recoverySummary } from "./runtime-recovery/summary.ts";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const plan: RecoveryPlan = {
  version: 1,
  operationId: id(1),
  accountId: "a".repeat(32),
  worker: "synthetic-worker",
  deploymentId: id(2),
  workerVersion: id(3),
  release: "b".repeat(40),
  applicationId: id(4),
  applicationVersion: 29,
  imageDigest: `sha256:${"c".repeat(64)}`,
  resources: { instanceType: null, vcpu: 0.25, memoryMiB: 1024, diskMiB: 4000, maxInstances: 1 },
  instanceId: "d".repeat(64),
  imageHash: "e".repeat(16),
  bootId: id(5),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reviewed-runtime-"));
  let boot = plan.bootId,
    posts = 0,
    restarts = 0;
  const mode = {
    lostReply: false,
    lostBeforeReceipt: false,
    changedAtPost: false,
    finalWriteFailure: false,
    invalidReply: false,
    postInspectionFailure: false,
    postProviderDrift: false,
  };
  const receipts = new Map<string, RecoveryReceipt>();
  const runtime = {
    instanceId: plan.instanceId,
    imageHash: plan.imageHash,
    release: plan.release,
    running: () => true,
    status: async () => ({ boot_id: boot, started_at: "2026-11-09T00:00:00Z" }),
    restart: async (beforeStop?: () => Promise<void>) => {
      await beforeStop?.();
      restarts++;
      boot = id(6);
      return runtime.status();
    },
  };
  const recovery = new RuntimeRecovery(runtime, {
    get: async <T>(key: string) => structuredClone(receipts.get(key)) as T | undefined,
    put: async (key, receipt) => {
      if (mode.finalWriteFailure && receipt.status !== "started")
        throw new Error("private-storage-sentinel");
      receipts.set(key, structuredClone(receipt));
    },
  });
  const service = {
    inspectRuntimeRecovery: (operation?: string) => recovery.inspect(operation),
    recoverRuntime: recovery.run.bind(recovery),
  };
  const application = {
    id: plan.applicationId,
    version: plan.applicationVersion,
    max_instances: 1,
    configuration: {
      image: `registry.invalid/pool@${plan.imageDigest}`,
      vcpu: 0.25,
      memory_mib: 1024,
      disk: { size_mb: 4000 },
      environment_variables: { private: "private-env-sentinel" },
    },
  };
  const instance = { id: plan.instanceId, status: { state: "running" } };
  const deployment = {
    id: plan.deploymentId,
    created_on: "2026-11-09T00:00:00Z",
    versions: [{ version_id: plan.workerVersion, percentage: 100 }],
  };
  const reads: string[] = [];
  const provider = () =>
    providerPins(plan, "private-api-token", async (input, init) => {
      assert.equal(init?.method, "GET");
      const path = new URL(String(input)).pathname;
      reads.push(path);
      return Response.json({
        success: true,
        errors: [],
        result: path.endsWith("/deployments")
          ? { deployments: [deployment] }
          : path.includes("/instances/")
            ? instance
            : application,
      });
    });
  const operations = {
    fetch: async (request: Request) => {
      if (request.method === "POST") {
        posts++;
        if (mode.lostBeforeReceipt) throw new Error("private-network-sentinel");
        if (mode.changedAtPost) boot = id(7);
      }
      if (request.method === "GET" && restarts > 0 && mode.postInspectionFailure)
        throw new Error("private-inspection-sentinel");
      const response = await handleRuntimeRecovery(request, service, "ab".repeat(32));
      if (request.method === "POST" && mode.postProviderDrift) application.version++;
      if (request.method === "POST" && mode.invalidReply) return Response.json({ invalid: true });
      if (request.method === "POST" && mode.lostReply) throw new Error("private-response-sentinel");
      return response;
    },
  };
  const deps = { directory, operations, provider, signingKey: "ab".repeat(32) };
  return {
    deps,
    runtime,
    application,
    instance,
    deployment,
    mode,
    reads,
    setBoot: (value: string) => {
      boot = value;
    },
    posts: () => posts,
    restarts: () => restarts,
    clean: () => rm(directory, { recursive: true, force: true }),
  };
}

test("reviewed plan digest binds every decoded pin and rejects undeclared input", () => {
  assert.deepEqual(reviewedPlan(JSON.stringify(plan), recoveryPlanDigest(plan)), plan);
  assert.throws(
    () => reviewedPlan(JSON.stringify({ ...plan, bootId: id(8) }), recoveryPlanDigest(plan)),
    /digest-mismatch/,
  );
  assert.throws(
    () => reviewedPlan(JSON.stringify({ ...plan, secret: "private" }), recoveryPlanDigest(plan)),
    /invalid-plan/,
  );
});

test("workflow dry run, one signed restart, new ready boot and durable repeat inspection", async () => {
  const f = await fixture();
  try {
    assert.equal((await runReviewedRecovery(plan, "dry-run", f.deps)).outcome, "dry-run");
    assert.equal(f.posts(), 0);
    const result = await runReviewedRecovery(plan, "apply", f.deps);
    assert.equal(result.outcome, "ready");
    assert.equal(result.receipt?.bootId, id(6));
    assert.equal(f.posts(), 1);
    assert.equal(f.restarts(), 1);
    assert.equal((await stat(join(f.deps.directory, "submission.json"))).mode & 0o777, 0o600);
    assert.equal((await runReviewedRecovery(plan, "apply", f.deps)).outcome, "inspection");
    assert.equal(f.posts(), 1);
    assert.ok(f.reads.some((path) => path.includes("/instances/")));
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.match(
      recoverySummary(plan, recoveryPlanDigest(plan), result),
      /One reviewed restart completed/,
    );
  } finally {
    await f.clean();
  }
});

test("release, provider image, instance, boot, resources and Worker drift all refuse without a POST", async () => {
  const changes = [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.runtime.release = "f".repeat(40);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.application.configuration.image = `registry.invalid/pool@sha256:${"f".repeat(64)}`;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.instance.id = "f".repeat(64);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.setBoot(id(9));
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.application.configuration.vcpu = 0.5;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.application.max_instances = 2;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.application.version = 30;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.deployment.id = id(10);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.deployment.versions[0]!.version_id = id(11);
    },
  ];
  for (const change of changes) {
    const f = await fixture();
    try {
      change(f);
      await assert.rejects(runReviewedRecovery(plan, "apply", f.deps), RecoveryWorkflowRefusal);
      assert.equal(f.posts(), 0);
      assert.equal(f.restarts(), 0);
      await assert.rejects(stat(join(f.deps.directory, "submission.json")), { code: "ENOENT" });
    } finally {
      await f.clean();
    }
  }
});

test("a boot changing after workflow dry run is refused at the destructive boundary and named", async () => {
  const f = await fixture();
  try {
    f.mode.changedAtPost = true;
    await assert.rejects(runReviewedRecovery(plan, "apply", f.deps), (error: unknown) => {
      assert.ok(error instanceof RecoveryWorkflowRefusal);
      assert.equal(error.drift[0]?.property, "bootId");
      const summary = recoverySummary(plan, recoveryPlanDigest(plan), error);
      assert.ok(
        summary.includes(plan.bootId) &&
          summary.includes(id(7)) &&
          summary.includes(plan.instanceId),
      );
      return true;
    });
    assert.equal(f.restarts(), 0);
    assert.equal(f.posts(), 1);
    assert.equal((await runReviewedRecovery(plan, "apply", f.deps)).outcome, "uncertain");
    assert.equal(f.posts(), 1);
  } finally {
    await f.clean();
  }
});

test("both accepted and unrecorded lost replies permit inspection only, never another POST", async () => {
  for (const accepted of [true, false]) {
    const f = await fixture();
    try {
      f.mode.lostReply = accepted;
      f.mode.lostBeforeReceipt = !accepted;
      const result = await runReviewedRecovery(plan, "apply", f.deps);
      assert.equal(result.outcome, accepted ? "inspection" : "uncertain");
      assert.equal(result.receipt?.status, accepted ? "ready" : undefined);
      await runReviewedRecovery(plan, "apply", f.deps);
      assert.equal(f.posts(), 1);
      assert.equal(f.restarts(), accepted ? 1 : 0);
      assert.ok(!JSON.stringify(result).includes("private"));
    } finally {
      await f.clean();
    }
  }
});

test("an inspection-only workflow attempt cannot submit even without a server receipt", async () => {
  const f = await fixture();
  try {
    assert.equal((await runReviewedRecovery(plan, "inspect", f.deps)).outcome, "uncertain");
    assert.equal(f.posts(), 0);
    assert.equal(f.restarts(), 0);
  } finally {
    await f.clean();
  }
});

test("a failed final audit preserves the started receipt after one restart", async () => {
  const f = await fixture();
  try {
    f.mode.finalWriteFailure = true;
    const result = await runReviewedRecovery(plan, "apply", f.deps);
    assert.equal(result.receipt?.status, "started");
    assert.equal(result.issues?.[0]?.reason, "restart-http-503");
    assert.equal(f.restarts(), 1);
    await runReviewedRecovery(plan, "apply", f.deps);
    assert.equal(f.posts(), 1);
    const summary = recoverySummary(plan, recoveryPlanDigest(plan), result);
    assert.match(summary, /started/);
    assert.match(summary, /restart-http-503/);
    assert.match(summary, /uncertain/);
    assert.ok(!summary.includes("private"));
  } finally {
    await f.clean();
  }
});

test("post-restart verification and cleanup failures retain the ready receipt and exact missing proof", async () => {
  for (const mode of ["postInspectionFailure", "postProviderDrift"] as const) {
    const f = await fixture();
    try {
      f.mode[mode] = true;
      const result = await runReviewedRecovery(plan, "apply", f.deps);
      assert.equal(result.outcome, "inspection");
      assert.equal(result.receipt?.status, "ready");
      assert.equal(result.receipt.bootId, id(6));
      assert.equal(
        result.issues?.[0]?.reason,
        mode === "postProviderDrift"
          ? "post-restart-pin-drift"
          : "post-restart-verification-unavailable",
      );
      const final = recordRecoveryIssue(
        result,
        new RecoveryWorkflowRefusal("bridge-teardown-unconfirmed"),
      );
      assert.equal(final.receipt, result.receipt);
      const summary = recoverySummary(plan, recoveryPlanDigest(plan), final);
      assert.match(summary, /ready/);
      assert.match(summary, /bridge-teardown-unconfirmed/);
      assert.ok(!summary.includes("private"));
      if (mode === "postProviderDrift") assert.match(summary, /applicationVersion.*29.*30/);
      assert.equal(f.posts(), 1);
      assert.equal(f.restarts(), 1);
    } finally {
      await f.clean();
    }
  }
});

test("parallel inventory failures name every resource without provider error text", async () => {
  await assert.rejects(
    providerPins(plan, "private-token", async () => {
      throw new Error("private-transport-sentinel");
    }),
    (error: unknown) => {
      assert.ok(error instanceof RecoveryWorkflowRefusal);
      assert.equal(error.drift.length, 3);
      const summary = recoverySummary(plan, recoveryPlanDigest(plan), error);
      assert.match(summary, /instances/);
      assert.match(summary, /deployments/);
      assert.ok(summary.includes(plan.applicationId) && summary.includes(plan.instanceId));
      assert.ok(!summary.includes("private"));
      return true;
    },
  );
});

test("failed receipt summaries show the retained failure reason", () => {
  for (const failure of ["boot-unchanged", "restart-failed"] as const) {
    const summary = recoverySummary(plan, recoveryPlanDigest(plan), {
      outcome: "inspection",
      submissionAttempted: false,
      plan,
      planSha256: recoveryPlanDigest(plan),
      receipt: {
        operationId: plan.operationId,
        instanceId: plan.instanceId,
        imageHash: plan.imageHash,
        release: plan.release,
        previousBootId: plan.bootId,
        status: "failed",
        startedAt: 1,
        failure,
      },
    });
    assert.match(summary, new RegExp(failure));
  }
});

test("an invalid successful POST reply still retains the durable ready receipt without repeating", async () => {
  const f = await fixture();
  try {
    f.mode.invalidReply = true;
    const result = await runReviewedRecovery(plan, "apply", f.deps);
    assert.equal(result.receipt?.status, "ready");
    assert.equal(result.issues?.[0]?.reason, "receipt-invalid");
    assert.equal(result.submissionAttempted, true);
    assert.match(
      recoverySummary(plan, recoveryPlanDigest(plan), result),
      /attempted one signed restart POST/,
    );
    await runReviewedRecovery(plan, "apply", f.deps);
    assert.equal(f.posts(), 1);
    assert.equal(f.restarts(), 1);
  } finally {
    await f.clean();
  }
});
