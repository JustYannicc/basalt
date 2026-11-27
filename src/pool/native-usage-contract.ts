import { Schema } from "effect";

/**
 * A device's own usage rows, authorized by the same per-request model assertion its model calls
 * carry. Under /pool/v1 so the router and the pool Worker already forward it to the controller.
 */
export const nativeUsagePath = "/pool/v1/native/usage";

/** Sessions one read may name, which bounds the Home lookups one request makes. */
export const nativeUsageMaxSessions = 20;

export const NativeUsageRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  at: Schema.String,
  /** The Home key the row was charged to, as Home reports it. The route returns only the device's own. */
  key: Schema.Number,
  /** Named only when it is in the device's pool; another pool's account never leaves the route. */
  account: Schema.NullOr(Schema.NonEmptyString),
  inPool: Schema.Boolean,
});
export type NativeUsageRecord = typeof NativeUsageRecord.Type;

export const NativeUsageSession = Schema.Struct({
  session: Schema.NonEmptyString,
  /** False when Home holds more rows for this session and key than one read returns. */
  complete: Schema.Boolean,
  records: Schema.Array(NativeUsageRecord),
});

export const NativeUsage = Schema.Struct({
  /** The device's own Home key. */
  key: Schema.Number,
  sessions: Schema.Array(NativeUsageSession),
});
export type NativeUsage = typeof NativeUsage.Type;
