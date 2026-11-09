import { Schema } from "effect";

const minute = 60_000;
const day = 24 * 60 * minute;
const hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const uuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
);
const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const AutomaticSample = Schema.Struct({
  at: timestamp,
  selection: hex,
  condition: Schema.Literals([
    "view-transport",
    "stopped",
    "unready",
    "stale-boot",
    "healthy",
    "unknown",
    "policy-invalid",
    "signature-invalid",
    "data-invalid",
  ]),
});
export type AutomaticSample = typeof AutomaticSample.Type;
const Attempt = Schema.Struct({
  operationId: uuid,
  instanceId: hex,
  at: timestamp,
  status: Schema.Literals(["started", "ready", "failed"]),
});
const Budget = Schema.Struct({ lastAt: timestamp, attempts: Schema.Array(Attempt) });
export type AutomaticBudget = typeof Budget.Type;

export function automaticEvidence(samples: readonly AutomaticSample[], now: number) {
  if (samples.length !== 3) return "insufficient-failures";
  const decode = Schema.decodeUnknownOption(Schema.Array(AutomaticSample))(samples);
  if (decode._tag === "None" || !Number.isSafeInteger(now) || now < 0) return "human-required";
  const first = samples[0]!;
  const last = samples[2]!;
  if (last.at > now || now - last.at > 30_000) return "stale-observation";
  if (samples.some((s) => s.selection !== first.selection)) return "target-drift";
  if (samples.some((s) => s.condition !== "view-transport")) return "human-required";
  for (let index = 1; index < samples.length; index++) {
    const elapsed = samples[index]!.at - samples[index - 1]!.at;
    if (elapsed < minute || elapsed > 90_000) return "sampling-gap";
  }
  return "eligible";
}

export function decodeAutomaticBudget(value: unknown): AutomaticBudget {
  try {
    const state = Schema.decodeUnknownSync(Budget, { onExcessProperty: "error" })(value);
    if (
      state.attempts.length > 3 ||
      state.attempts.some((a) => a.at > state.lastAt) ||
      new Set(state.attempts.map((a) => a.operationId)).size !== state.attempts.length
    )
      throw new Error();
    return state;
  } catch {
    throw new Error("automatic-recovery-invalid-state");
  }
}

/** The serialized recovery owner persists this before its started receipt and any destruction. */
export function consumeAutomaticAttempt(
  retained: unknown,
  target: { operationId: string; instanceId: string },
  now: number,
): AutomaticBudget {
  const attempt = Schema.decodeUnknownSync(Attempt)({ ...target, at: now, status: "started" });
  const state =
    retained === undefined ? { lastAt: now, attempts: [] } : decodeAutomaticBudget(retained);
  if (now < state.lastAt) throw new Error("automatic-recovery-clock-regression");
  if (state.attempts.some((a) => a.operationId === target.operationId))
    throw new Error("automatic-recovery-already-consumed");
  if (state.attempts.some((a) => a.status === "started"))
    throw new Error("automatic-recovery-uncertain");
  const recent = state.attempts.filter((a) => now - a.at < day);
  if (recent.some((a) => a.instanceId === target.instanceId && now - a.at < 30 * minute))
    throw new Error("automatic-recovery-cooldown");
  if (recent.length >= 3) throw new Error("automatic-recovery-daily-limit");
  return { lastAt: now, attempts: [...recent, attempt] };
}

export function finishAutomaticAttempt(
  retained: unknown,
  operationId: string,
  status: "ready" | "failed",
): AutomaticBudget {
  const state = decodeAutomaticBudget(retained);
  if (!state.attempts.some((a) => a.operationId === operationId))
    throw new Error("automatic-recovery-unknown-operation");
  return {
    ...state,
    attempts: state.attempts.map((a) => (a.operationId === operationId ? { ...a, status } : a)),
  };
}
