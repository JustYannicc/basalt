import { eventId, sendEnvelope } from "./sentry-envelope.ts";
import type { SentryEnv } from "./sentry-target.ts";

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
    const id = eventId();
    event = sendEnvelope(env, {
      id,
      type: "event",
      payload: {
        event_id: id,
        timestamp: new Date().toISOString(),
        platform: "javascript",
        level: "error",
        message: `pool_availability_failure ${failures.map((failure) => `${failure.guard}:${failure.reason}${failure.backend_status ? `:HTTP${failure.backend_status}` : ""}`).join(" ") || "runtime:unknown"}`,
        logger: "pool-availability",
        fingerprint: ["basalt", "pool_availability_failure"],
        tags: {
          error_code: "pool_availability_failure",
          guard: failures[0]?.guard ?? "runtime",
          reason: failures[0]?.reason ?? "unknown",
        },
        contexts: { pool_probe: { check_in_id: receipt.id, failures } },
      },
    });
  }
  const results = await Promise.all([check, event]);
  return receipt.accepted && results.every(Boolean);
}
