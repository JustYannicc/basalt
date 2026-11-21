import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  ControllerRefused,
  runCrashDispatch,
  type DispatchDependencies,
} from "./pool-crash-dispatch.ts";

// Shaped like the first observe after the legacy root was adopted as selection epoch 1: only an
// active record, matching active-health, no fleet yet, and a root status read the controller refuses.
const accountId = "a".repeat(32);
const controllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
const legacyTarget = {
  format: "pool-runtime-slot-v1",
  controllerId: "1".repeat(64),
  slotId: "legacy",
  applicationId: "00000000-0000-4000-8000-000000000057",
  applicationVersion: "57",
  instanceId: "1".repeat(64),
  imageDigest: `sha256:${"2".repeat(64)}`,
  imageInput: "3".repeat(16),
};
const legacyIdentity = { ...legacyTarget, bootId: "00000000-0000-4000-8000-0000000000b1" };
const adopted = {
  selection: {
    epoch: 1,
    active: { target: legacyTarget, identity: legacyIdentity, fenced: false },
  },
  policies: [],
  denials: [],
  digest: "4".repeat(64),
};
const promotedTarget = {
  ...legacyTarget,
  slotId: "release-fixture-0001",
  applicationId: "00000000-0000-4000-8000-000000000058",
  applicationVersion: "58",
  instanceId: "5".repeat(64),
  imageDigest: `sha256:${"6".repeat(64)}`,
  imageInput: "7".repeat(16),
};

function observeWorld(inspected: unknown, witness: (target: unknown) => unknown) {
  const calls: string[] = [];
  const witnessed: unknown[] = [];
  const deps: DispatchDependencies = {
    listRuns: async () => [],
    readTarget: async () => ({
      accountId,
      worker: "synthetic-pool",
      root: {
        applicationId: legacyTarget.applicationId,
        applicationVersion: "57",
        imageDigest: legacyTarget.imageDigest,
        imageInput: legacyTarget.imageInput,
      },
    }),
    resetRecovery: async () => {
      throw new Error("observe never resets recovery");
    },
    rootHealth: async () => {
      calls.push("rootHealth");
      throw new Error("root health HTTP 409");
    },
    sleep: async () => {},
    observe: async (action, _code, _target, _key, slot) => {
      calls.push(action);
      if (action === "inspect") return { result: inspected };
      if (action === "fleet-inspect") return { result: { resources: [], bindings: [] } };
      if (action === "active-health") return { result: { identity: legacyIdentity, leaseMs: 937 } };
      witnessed.push(slot);
      return { result: witness(slot) };
    },
    crash: async () => {
      throw new Error("observe never crashes");
    },
    now: () => 1,
  };
  return { deps, calls, witnessed };
}

const observe = (deps: DispatchDependencies) =>
  runCrashDispatch(
    {
      mode: "observe",
      requestId: crypto.randomUUID(),
      packet: JSON.stringify({ controllerCode }),
      coordinatorGo: "GO observe the selected runtime",
      accountId,
      signingKey: randomBytes(32).toString("hex"),
      ref: "refs/heads/main",
      event: "workflow_dispatch",
      runId: 7,
      runAttempt: "1",
    },
    deps,
  );

test("an adopted legacy selection is witnessed directly, without the refused root read", async () => {
  const { deps, calls, witnessed } = observeWorld(adopted, () => ({
    kind: "unattested-active",
    controllerCode,
    operationId: "adopt-fixture",
    manifestDigest: "m",
    identity: legacyIdentity,
  }));
  const result = await observe(deps);
  assert.equal(result.ok, true);
  assert.ok(!calls.includes("rootHealth"));
  assert.deepEqual(witnessed, [legacyTarget]);
  const diagnostic = result.diagnostic as { root: unknown; witness: unknown };
  assert.deepEqual(diagnostic.root, { skipped: "selection-present" });
  assert.deepEqual(diagnostic.witness, {
    slotId: "legacy",
    kind: "unattested-active",
    operationId: "adopt-fixture",
    manifestDigest: "m",
    bootId: legacyIdentity.bootId,
  });
});

test("after a release the witness follows the promoted slot, not the draining legacy", async () => {
  const restarted = { ...promotedTarget, bootId: "00000000-0000-4000-8000-0000000000b3" };
  const draining = {
    ...adopted.selection.active,
    retirement: { operationId: "drain-fixture", status: "started" },
  };
  const { deps, calls, witnessed } = observeWorld(
    {
      ...adopted,
      selection: {
        epoch: 3,
        active: { target: promotedTarget, identity: restarted, fenced: false },
        draining,
      },
    },
    () => ({
      kind: "witness",
      controllerCode,
      witness: { operationId: "restart-fixture", manifestDigest: "r", bootId: restarted.bootId },
    }),
  );
  const result = await observe(deps);
  assert.equal(result.ok, true);
  assert.ok(!calls.includes("rootHealth"));
  assert.deepEqual(witnessed, [promotedTarget]);
  // The restart's witness names the boot the selection now reports, for the proof operator to compare.
  assert.deepEqual((result.diagnostic as { witness: unknown }).witness, {
    slotId: promotedTarget.slotId,
    kind: "witness",
    operationId: "restart-fixture",
    manifestDigest: "r",
    bootId: restarted.bootId,
  });
});

test("a staged candidate leaves the witness on the active slot and records its refusal", async () => {
  const { deps, witnessed } = observeWorld(
    {
      ...adopted,
      selection: {
        ...adopted.selection,
        epoch: 2,
        candidate: { target: promotedTarget, fenced: false },
      },
    },
    () => {
      throw new ControllerRefused("witness", "selection");
    },
  );
  const result = await observe(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(witnessed, [legacyTarget]);
  assert.deepEqual((result.diagnostic as { witness: unknown }).witness, {
    ok: false,
    refused: "selection",
  });
});

test("an unreadable selection reports itself instead of falling back to the root", async () => {
  const { deps, calls, witnessed } = observeWorld({ ...adopted, selection: { epoch: 1 } }, () => {
    throw new Error("no witness expected");
  });
  const result = await observe(deps);
  assert.equal(result.ok, true);
  assert.ok(!calls.includes("rootHealth"));
  assert.deepEqual(witnessed, []);
  assert.deepEqual((result.diagnostic as { witness: unknown }).witness, {
    ok: false,
    error: "selection active target unreadable; witness not sent",
  });
});

test("an apply forwards the selected identity packet unchanged, without root reads", async () => {
  const nonce = crypto.randomUUID();
  const packet = { controllerCode, identity: legacyIdentity, nonce, operator: "fixture-operator" };
  const sent: unknown[] = [];
  const { deps, calls } = observeWorld(adopted, () => ({}));
  const result = await runCrashDispatch(
    {
      mode: "apply",
      requestId: nonce,
      packet: JSON.stringify(packet),
      coordinatorGo: "GO crash the selected primary",
      accountId,
      signingKey: randomBytes(32).toString("hex"),
      ref: "refs/heads/main",
      event: "workflow_dispatch",
      runId: 7,
      runAttempt: "1",
    },
    {
      ...deps,
      crash: async (request) => {
        sent.push(request.packet);
        return { inspection: false, result: { status: "signalled" } };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ ...packet, accountId, worker: "synthetic-pool" }]);
  assert.deepEqual(calls, []);
});
