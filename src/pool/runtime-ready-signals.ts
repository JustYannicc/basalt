import { Effect, Option, Schema, SchemaTransformation } from "effect";

const steps = ["home_plugins", "plugin_probe", "probe_log", "node_audit", "no_probe"] as const;
const flipTargets = ["ready", "refusing"] as const;
const flipReasons = ["restored", "policy_fused", "policy_unproven", "degraded"] as const;

// The container's text never survives: a value outside its closed set or shape reads as null.
const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null))));
// Inside a record a missing value reads as null too, so one bad slot keeps its siblings.
const slot = <S extends Schema.Top>(schema: S) =>
  nullable(schema).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null)));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const utcMillis = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const Instant = Schema.String.check(
  Schema.makeFilter((value: string) => {
    if (!utcMillis.test(value)) return false;
    const date = new Date(value);
    // A rolled-over date such as 30 February parses, but to another instant.
    return !Number.isNaN(date.getTime()) && date.toISOString() === value;
  }),
);
// What prints is always the Worker's own rendering of the instant, never the container's string.
const At = Instant.pipe(
  Schema.decodeTo(
    Instant,
    SchemaTransformation.transform({
      decode: (value: string) => new Date(value).toISOString(),
      encode: (value: string) => value,
    }),
  ),
);

/**
 * What a container's readiness answer says about its own recent past: its latest slow probe step
 * (a lapse), its latest change of answer (a flip), its supervisor's latest late wake-up with what
 * the scheduler did meanwhile (a stall), and how many of each since its supervisor started. Each field is absent until its first record, and an older image sends none. Decoding
 * keeps only closed values, so the same schema decodes the container's answer and a copy of it
 * that crossed a binding.
 */
export const ReadySignals = Schema.Struct({
  lastLapse: Schema.optionalKey(
    nullable(Schema.Struct({ step: slot(Schema.Literals(steps)), ms: slot(Count), at: slot(At) })),
  ),
  lastFlip: Schema.optionalKey(
    nullable(
      Schema.Struct({
        to: slot(Schema.Literals(flipTargets)),
        reason: slot(Schema.Literals(flipReasons)),
        priorMs: slot(Count),
        at: slot(At),
      }),
    ),
  ),
  lastStall: Schema.optionalKey(
    nullable(
      Schema.Struct({
        lateMs: slot(Count),
        cpuMs: slot(Count),
        stealMs: slot(Count),
        throttledMs: slot(Count),
        at: slot(At),
      }),
    ),
  ),
  lapses: Schema.optionalKey(nullable(Count)),
  flips: Schema.optionalKey(nullable(Count)),
  stalls: Schema.optionalKey(nullable(Count)),
});
export type ReadySignals = typeof ReadySignals.Type;

const decode = Schema.decodeUnknownOption(ReadySignals);
/** The closed signals in an already renamed value, or nothing when it carries none. */
export function decodeReadySignals(value: unknown): ReadySignals | undefined {
  const decoded = decode(value);
  return Option.isSome(decoded) && Object.keys(decoded.value).length > 0
    ? decoded.value
    : undefined;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** The container's readiness body, read under the Worker's names; nothing else in it is read. */
export function readySignals(body: unknown) {
  if (!record(body)) return undefined;
  const flip = body.last_flip;
  const stall = body.last_stall;
  return decodeReadySignals({
    ...("last_lapse" in body ? { lastLapse: body.last_lapse } : {}),
    ...("last_flip" in body
      ? {
          lastFlip: record(flip)
            ? { to: flip.to, reason: flip.reason, priorMs: flip.prior_ms, at: flip.at }
            : flip,
        }
      : {}),
    ...("last_stall" in body
      ? {
          lastStall: record(stall)
            ? {
                lateMs: stall.late_ms,
                cpuMs: stall.cpu_ms,
                stealMs: stall.steal_ms,
                throttledMs: stall.throttled_ms,
                at: stall.at,
              }
            : stall,
        }
      : {}),
    ...("lapses" in body ? { lapses: body.lapses } : {}),
    ...("flips" in body ? { flips: body.flips } : {}),
    ...("stalls" in body ? { stalls: body.stalls } : {}),
  });
}

// Keeps exception identity, as the route diagnostic does, so existing refusal handling is unchanged.
const carried = new WeakMap<object, ReadySignals>();
/** The refusal, now carrying the readiness answer's signals unless it already carries some. */
export function withReadySignals<E>(error: E, signals: ReadySignals | undefined): E {
  if (signals && typeof error === "object" && error !== null && !carried.has(error))
    carried.set(error, signals);
  return error;
}
export function runtimeReadySignals(error: unknown) {
  return typeof error === "object" && error !== null ? carried.get(error) : undefined;
}
