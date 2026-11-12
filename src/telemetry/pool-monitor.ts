import { eventId, sendEnvelope } from "./sentry-envelope.ts";
import type { SentryEnv } from "./sentry-target.ts";
import type { PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";

const guards = new Set([
  "configuration",
  "runtime",
  "pool_view",
  "membership",
  "native_guard",
  "membership_read",
  "membership_body",
  "reconciliation",
  "native_policy_install",
  "request_reliability",
]);
const reasons = new Set([
  "invalid_target",
  "stopped",
  "unavailable",
  "invalid_body",
  "missing",
  "dirty",
  "unacknowledged",
  "renewal_overdue",
  "response_status",
  "transport",
  "timeout",
  "runtime_unhealthy",
  "storage",
  "unknown",
  "below_target",
  "collection_unavailable",
]);

export async function startPoolMonitor(env: SentryEnv) {
  const receipt = { id: eventId(), started: performance.now() };
  const accepted = await sendEnvelope(env, {
    id: receipt.id,
    type: "check_in",
    payload: {
      check_in_id: receipt.id,
      monitor_slug: "pool-availability",
      status: "in_progress",
    },
  });
  return { ...receipt, accepted };
}

/** Check-ins use an existing monitor. Runtime code never creates or configures alert routing. */
export async function capturePoolMonitor(
  env: SentryEnv,
  receipt: Awaited<ReturnType<typeof startPoolMonitor>>,
  input: {
    ok: boolean;
    failures: readonly { guard: string; reason: string; backendStatus?: number }[];
    reliability?: PoolReliabilitySlo;
  },
): Promise<boolean> {
  const failures = input.failures.slice(0, 8).map((failure) => ({
    guard: guards.has(failure.guard) ? failure.guard : "runtime",
    reason: reasons.has(failure.reason) ? failure.reason : "unknown",
    ...(typeof failure.backendStatus === "number" &&
    Number.isInteger(failure.backendStatus) &&
    failure.backendStatus >= 100 &&
    failure.backendStatus <= 599
      ? { backend_status: failure.backendStatus }
      : {}),
  }));
  const ok = input.ok && failures.length === 0;
  const check = sendEnvelope(env, {
    id: receipt.id,
    type: "check_in",
    payload: {
      check_in_id: receipt.id,
      monitor_slug: "pool-availability",
      status: ok ? "ok" : "error",
      duration: Math.max(0, performance.now() - receipt.started) / 1000,
    },
  });
  let event = Promise.resolve(true);
  if (!ok) {
    const reliability = failures.find((failure) => failure.guard === "request_reliability");
    const errorCode =
      reliability?.reason === "below_target"
        ? "pool_request_success_below_target"
        : reliability?.reason === "collection_unavailable"
          ? "pool_request_collection_unavailable"
          : "pool_availability_failure";
    const id = eventId();
    event = sendEnvelope(env, {
      id,
      type: "event",
      payload: {
        event_id: id,
        timestamp: new Date().toISOString(),
        platform: "javascript",
        level: "error",
        message: `${errorCode} ${failures.map((failure) => `${failure.guard}:${failure.reason}${failure.backend_status ? `:HTTP${failure.backend_status}` : ""}`).join(" ") || "runtime:unknown"}`,
        logger: "pool-availability",
        fingerprint: ["basalt", errorCode],
        tags: {
          error_code: errorCode,
          guard: failures[0]?.guard ?? "runtime",
          reason: failures[0]?.reason ?? "unknown",
        },
        contexts: {
          pool_probe: { check_in_id: receipt.id, failures },
          ...(input.reliability
            ? { request_reliability: reliabilityContext(input.reliability) }
            : {}),
        },
      },
    });
  }
  const results = await Promise.all([check, event]);
  return receipt.accepted && results.every(Boolean);
}

function reliabilityContext(slo: PoolReliabilitySlo) {
  const count = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const window = (value: PoolReliabilitySlo["hour"]) => ({
    requests: count(value.real.requests),
    failed: count(value.real.failed),
    proof_requests: count(value.proof.requests),
    proof_failed: count(value.proof.failed),
  });
  return {
    target: 99,
    hour: window(slo.hour),
    day: window(slo.day),
    reason: [
      "history_inactive",
      "capture_stale",
      "capture_lagging",
      "classification_pending",
    ].includes(slo.reason ?? "")
      ? slo.reason
      : null,
  };
}
