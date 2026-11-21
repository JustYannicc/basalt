import { Schema } from "effect";
import { executionKey, type SlotIdentity } from "./contract.ts";
import type { RuntimeSlotStorage } from "./storage.ts";
import {
  forcedRestartBudgetMs,
  forcedRestartsPerHour,
  unservingBoundMs,
} from "./forced-restart-timing.ts";

const clockKey = "runtime-slots-v1:unserving";
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
  /** Streams counted active that hold the stop, and since when their count has stood still. */
  streams: Schema.optional(Schema.Struct({ active: Schema.Number, stillSince: Schema.Number })),
});
export type UnservingState = typeof UnservingState.Type;
type Decision = "wait" | "needs_person" | "restart_limit" | "stop";

/** What the clock allows for this pass; pure, so the bounds are testable on their own. */
export function unservingDecision(state: UnservingState, now: number): Decision {
  if (state.needsPerson) return "needs_person";
  if (state.since === undefined || now - state.since < unservingBoundMs) return "wait";
  if (state.restarts.filter((at) => at > now - hourMs).length >= forcedRestartsPerHour)
    return "restart_limit";
  return "stop";
}

/**
 * How long the selected runtime has been running but not serving, and the forced restarts made for
 * it. Durable, so a controller isolate restart neither resets the bound nor the hourly limit.
 */
export class UnservingClock {
  private storage: RuntimeSlotStorage;
  // Only this controller writes the clock, so a clean state seen here stays clean until it does.
  private clean = false;
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
  /** The selected boot isn't running and refusing right now: the bound starts again next time. */
  notRefusing() {
    if (this.clean) return Promise.resolve({ restarts: [] });
    return this.change((state) =>
      state.since === undefined && !state.streams
        ? state
        : { ...state, since: undefined, streams: undefined },
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
  /** The stop no longer waits on streams. */
  notWaiting() {
    return this.change((state) => (state.streams ? { ...state, streams: undefined } : state));
  }
  /** The stop waits on streams; recorded so a person sees a wait, not a hang. */
  waitingFor(streams: NonNullable<UnservingState["streams"]>) {
    return this.change((state) =>
      state.streams?.active === streams.active && state.streams.stillSince === streams.stillSince
        ? state
        : { ...state, streams },
    );
  }
  restarted(now: number) {
    return this.change((state) => ({
      ...state,
      since: undefined,
      streams: undefined,
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
  async serving() {
    if (this.clean) return;
    await this.change((state) =>
      state.since === undefined &&
      state.restartedAt === undefined &&
      !state.needsPerson &&
      !state.streams
        ? state
        : { restarts: state.restarts },
    );
    this.clean = true;
  }
  /**
   * The operator's way out of "needs a person": a fresh bound and hourly count here. The container
   * object's own three-an-hour stop count isn't reset. It never reads the stored row, so a row
   * that no longer decodes can't block it.
   */
  reset() {
    this.clean = false;
    return this.storage.transact(async (_, transaction) => {
      const state = { restarts: [] };
      await transaction.put(clockKey, state);
      return state;
    });
  }
  private change(next: (state: UnservingState) => UnservingState, write = true) {
    return this.storage.transact(async (_, transaction) => {
      const raw = await transaction.get(clockKey);
      const state =
        raw === undefined ? { restarts: [] } : Schema.decodeUnknownSync(UnservingState)(raw);
      const updated = next(state);
      if (write && updated !== state) {
        this.clean = false;
        await transaction.put(clockKey, updated);
      }
      return updated;
    });
  }
}
