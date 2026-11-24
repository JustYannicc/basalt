import { Schema } from "effect";

/** At or under this many milliseconds to the database pooler, a runtime can carry load. */
export const nearDatabaseMs = 20;
/**
 * A far cell the fleet needs now serves at once only up to this distance: just past the farthest
 * draws measured so far (the 18 Nov placement trial: Athens 44 ms and Lisbon 40 ms, at most 48 ms in
 * any sample; ath01 at 44 and 45 ms on 24 Nov). Farther draws keep the redraw rule.
 */
export const neededFarMs = 50;

/**
 * What a runtime's readiness reports about its own distance to the database, measured once per boot
 * over Home's own database pool before the node starts. An image without the measurement reports
 * nothing, which means unknown.
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
  const decoded = Schema.decodeUnknownOption(RuntimeDistance)({
    state,
    ...(typeof rtt === "number" ? { rttMs: rtt } : {}),
  });
  if (decoded._tag === "None") return undefined;
  // A measured or held state without its number carries no distance.
  if ((state === "measured" || state === "held") && decoded.value.rttMs === undefined)
    return undefined;
  // The location is decoded on its own, so a malformed code never discards a valid distance.
  const place = Schema.decodeUnknownOption(RuntimeDistance)({ state, location });
  return place._tag === "Some" && typeof location === "string"
    ? { ...decoded.value, location }
    : decoded.value;
}

export function distanceClass(distance: RuntimeDistance | undefined): DistanceClass {
  if (distance?.state === "held") return "far";
  if (distance?.state !== "measured" || distance.rttMs === undefined) return "unknown";
  return distance.rttMs <= nearDatabaseMs ? "near" : "far";
}
