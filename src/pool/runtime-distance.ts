import { Schema } from "effect";

/** At or under this many milliseconds to the database pooler, a runtime can carry load. */
export const nearDatabaseMs = 20;

/**
 * What a runtime's readiness reports about its own distance to the database, measured once per boot
 * before Home starts. An image without the measurement reports nothing, which means unknown.
 */
export const RuntimeDistance = Schema.Struct({
  state: Schema.Literals(["pending", "measured", "failed", "held"]),
  rttMs: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 3_500 })),
  ),
  location: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z]{3}[0-9]{2}$/u))),
});
export type RuntimeDistance = typeof RuntimeDistance.Type;
export type DistanceClass = "near" | "far" | "unknown";

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;

/** Reads the readiness body's closed distance fields; anything malformed or out of range is absent. */
export function readinessDistance(body: unknown): RuntimeDistance | undefined {
  const state = field(body, "db_rtt_state");
  if (state !== "pending" && state !== "measured" && state !== "failed" && state !== "held")
    return undefined;
  const rtt = field(body, "db_rtt_ms");
  const location = field(body, "location");
  const candidate = {
    state,
    ...(typeof rtt === "number" ? { rttMs: rtt } : {}),
    ...(typeof location === "string" ? { location } : {}),
  };
  const decoded = Schema.decodeUnknownOption(RuntimeDistance)(candidate);
  if (decoded._tag === "None") return undefined;
  // A measured or held state without its number carries no distance.
  return (state === "measured" || state === "held") && decoded.value.rttMs === undefined
    ? undefined
    : decoded.value;
}

export function distanceClass(distance: RuntimeDistance | undefined): DistanceClass {
  if (distance?.state === "held") return "far";
  if (distance?.state !== "measured" || distance.rttMs === undefined) return "unknown";
  return distance.rttMs <= nearDatabaseMs ? "near" : "far";
}
