import { Schema } from "effect";
import { executionKey, type SlotIdentity } from "./contract.ts";
import type { RuntimeSlotStorage } from "./storage.ts";

const clockKey = "runtime-slots-v1:unserving";
/** A selected runtime that is running but refusing this long is stopped, so recovery replaces it. */
export const unservingBoundMs = 60_000;
/** Past this, a stop no longer waits for streams counted active; a leaked count can't block it. */
export const unservingStreamCapMs = 300_000;
/** A forced restart that hasn't produced a serving runtime by now has failed. */
export const forcedRestartBudgetMs = 300_000;
export const forcedRestartsPerHour = 3;
const hourMs = 3_600_000;

const NeedsPerson = Schema.Struct({
  at: Schema.Number,
  reason: Schema.Literals(["stop_failed", "restart_failed", "restart_limit"]),
});
export const UnservingState = Schema.Struct({
  boot: Schema.optional(Schema.String),
  since: Schema.optional(Schema.Number),
  restartedAt: Schema.optional(Schema.Number),
  restarts: Schema.Array(Schema.Number),
  needsPerson: Schema.optional(NeedsPerson),
});
export type UnservingState = typeof UnservingState.Type;
type Decision = "wait" | "needs_person" | "restart_limit" | { force: boolean };

/** What the clock allows for this pass; pure, so the bounds are testable on their own. */
export function unservingDecision(state: UnservingState, now: number): Decision {
  if (state.needsPerson) return "needs_person";
  if (state.since === undefined || now - state.since < unservingBoundMs) return "wait";
  if (state.restarts.filter((at) => at > now - hourMs).length >= forcedRestartsPerHour)
    return "restart_limit";
  return { force: now - state.since >= unservingStreamCapMs };
}

/**
 * How long the selected runtime has been running but not serving, and the forced restarts made for
 * it. Durable, so a controller isolate restart neither resets the bound nor the hourly limit.
 */
export class UnservingClock {
  private storage: RuntimeSlotStorage;
  constructor(storage: RuntimeSlotStorage) {
    this.storage = storage;
  }
  inspect() {
    return this.change((state) => state, false);
  }
  /** A refusal while the container runs: starts the bound once per boot. */
  refusing(identity: SlotIdentity, now: number) {
    const boot = executionKey(identity);
    return this.change((state) =>
      state.boot === boot && state.since !== undefined ? state : { ...state, boot, since: now },
    );
  }
  /** A refusal of any kind: a forced restart that still hasn't served has failed. */
  failedSince(now: number) {
    return this.change((state) =>
      state.restartedAt !== undefined &&
      !state.needsPerson &&
      now - state.restartedAt >= forcedRestartBudgetMs
        ? { ...state, needsPerson: { at: now, reason: "restart_failed" as const } }
        : state,
    );
  }
  restarted(now: number) {
    return this.change((state) => ({
      ...state,
      since: undefined,
      restartedAt: now,
      restarts: [...state.restarts.filter((at) => at > now - hourMs), now],
    }));
  }
  needsPerson(reason: NonNullable<UnservingState["needsPerson"]>["reason"], now: number) {
    return this.change((state) =>
      state.needsPerson ? state : { ...state, needsPerson: { at: now, reason } },
    );
  }
  /** Serving again. The hourly restart count stays, so a flapping runtime still meets its limit. */
  serving() {
    return this.change((state) =>
      state.since === undefined && state.restartedAt === undefined && !state.needsPerson
        ? state
        : { restarts: state.restarts },
    );
  }
  /** The operator's way out of "needs a person": the next refusal starts a fresh bound and limit. */
  reset() {
    return this.change(() => ({ restarts: [] }));
  }
  private change(next: (state: UnservingState) => UnservingState, write = true) {
    return this.storage.transact(async (_, transaction) => {
      const raw = await transaction.get(clockKey);
      const state =
        raw === undefined ? { restarts: [] } : Schema.decodeUnknownSync(UnservingState)(raw);
      const updated = next(state);
      if (write && updated !== state) await transaction.put(clockKey, updated);
      return updated;
    });
  }
}
