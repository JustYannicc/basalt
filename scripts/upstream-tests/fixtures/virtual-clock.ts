import { Clock, Duration, Effect } from "effect";

/**
 * A Clock whose sleeps advance its own time instead of waiting, so a provider's readiness backoff
 * costs a regression no real time. `slept` is the virtual time every sleep asked for; a sleep past
 * `limit` dies, so a retry that never gives up fails instead of spinning.
 */
export function virtualClock(limit = Number.POSITIVE_INFINITY, start = Date.UTC(2026, 10, 28)) {
  let now = start;
  // A sleep may add fractional milliseconds; the clock still answers whole nanoseconds.
  const nanos = () => BigInt(Math.round(now * 1_000_000));
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) => {
      const millis = Duration.toMillis(duration);
      if (state.slept + millis > limit)
        return Effect.die(new Error(`Slept past the ${limit} ms this regression allows`));
      return Effect.sync(() => {
        now += millis;
        state.slept += millis;
      });
    },
  };
  const state = { slept: 0, clock };
  return state;
}
