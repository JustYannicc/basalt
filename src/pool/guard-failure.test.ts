import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosePoolFailure,
  failureResponse,
  poolFailureDiagnostic,
  type PoolFailureDiagnostic,
} from "./json.ts";
import { poolGuard } from "./guard-failure.ts";

test("the diagnostic boundary drops extra properties and snapshots only validated fields", (t) => {
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => reports.push(args));
  const diagnostic = {
    guard: "reconciliation" as const,
    failure: "response_status" as const,
    backendStatus: 500,
    body: "private backend text",
  };
  const error = new Error("private exception text");
  assert.equal(diagnosePoolFailure(error, diagnostic), error);
  diagnostic.backendStatus = 401;
  assert.equal(failureResponse(error).status, 503);
  assert.deepEqual(reports, [
    [
      "pool_guard_failure",
      {
        guard: "reconciliation",
        failure: "response_status",
        backendStatus: 500,
      },
    ],
  ]);
});

test("out-of-range statuses and arbitrary class strings cannot enter diagnostics", (t) => {
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => reports.push(args));
  for (const backendStatus of [0, 99, 600, NaN, Infinity]) {
    const error = new Error();
    diagnosePoolFailure(error, {
      guard: "membership_body",
      failure: "invalid_body",
      backendStatus,
    });
    failureResponse(error);
  }
  assert.equal(reports.length, 5);
  assert.ok(
    reports.every(
      (report) =>
        JSON.stringify(report) ===
        JSON.stringify([
          "pool_guard_failure",
          { guard: "membership_body", failure: "invalid_body" },
        ]),
    ),
  );
  for (const diagnostic of [
    { guard: "private selector", failure: "unknown" },
    { guard: "membership_read", failure: "private error" },
  ]) {
    const error = new Error();
    diagnosePoolFailure(error, diagnostic as PoolFailureDiagnostic);
    failureResponse(error);
  }
  assert.equal(reports.length, 5);
});

test("guard annotation and a broken reporter preserve the original failure", async (t) => {
  const error = new Error("private exception text");
  await assert.rejects(
    poolGuard("reconciliation", async () => {
      throw error;
    }),
    (caught) => caught === error,
  );
  t.mock.method(console, "error", () => {
    throw new Error("reporter failed");
  });
  const response = failureResponse(error);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "backend_unavailable",
    message: "The pool backend is unavailable. Try again later.",
  });
});

test("lease-window telemetry keeps signed bounds only for native policy failures", (t) => {
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => reports.push(args));
  for (const leaseMs of [-60_000, 0, 60_000]) {
    const error = new Error();
    diagnosePoolFailure(error, {
      guard: "native_policy_install",
      failure: "response_status",
      reason: "lease_window",
      leaseMs,
    });
    failureResponse(error);
    assert.deepEqual(reports.at(-1), [
      "pool_guard_failure",
      {
        guard: "native_policy_install",
        failure: "response_status",
        reason: "lease_window",
        leaseMs,
      },
    ]);
  }
  for (const diagnostic of [
    { guard: "native_policy_install", reason: "lease_window", leaseMs: -60_001 },
    { guard: "native_policy_install", reason: "lease_window", leaseMs: 60_001 },
    { guard: "native_policy_install", reason: "lease_window", leaseMs: NaN },
    { guard: "native_policy_install", reason: "lease_window", leaseMs: Infinity },
    { guard: "native_policy_install", reason: "lease_window", leaseMs: 0.5 },
    { guard: "native_policy_install", reason: "json", leaseMs: 50 },
    { guard: "membership_read", reason: "lease_window", leaseMs: 50 },
  ] as const) {
    const error = new Error();
    diagnosePoolFailure(error, { ...diagnostic, failure: "response_status" });
    failureResponse(error);
    assert.ok(!JSON.stringify(reports.at(-1)).includes("leaseMs"));
  }
});

test("native install observations admit only closed phases, bounded integers and booleans", () => {
  for (const phase of ["request", "acknowledgement"] as const)
    for (const elapsedMs of [0, 60_000]) {
      const observation = { phase, elapsedMs, deadlineAborted: elapsedMs > 0 };
      const error = new Error("private exception");
      diagnosePoolFailure(error, {
        guard: "native_policy_install",
        failure: "transport",
        ...observation,
      });
      assert.deepEqual(poolFailureDiagnostic(error), {
        guard: "native_policy_install",
        failure: "transport",
        ...observation,
      });
    }
  for (const elapsedMs of [-1, 60_001, 0.5, NaN, Infinity]) {
    const error = new Error();
    diagnosePoolFailure(error, {
      guard: "native_policy_install",
      failure: "transport",
      phase: "private phase",
      elapsedMs,
      deadlineAborted: "private status",
    } as unknown as PoolFailureDiagnostic);
    assert.deepEqual(poolFailureDiagnostic(error), {
      guard: "native_policy_install",
      failure: "transport",
    });
  }
  const error = new Error();
  diagnosePoolFailure(error, {
    guard: "membership_read",
    failure: "transport",
    phase: "request",
    elapsedMs: 1,
    deadlineAborted: true,
  });
  assert.deepEqual(poolFailureDiagnostic(error), {
    guard: "membership_read",
    failure: "transport",
  });
});
