import { HomeTransportFailure, object, text, type Json } from "./json.ts";

type Reason =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "rejected"
  | "invalid_response"
  | "timed_out";
export interface AccountFailureDetail {
  source: "provider" | "home" | "transport";
  reason: Reason;
  status?: number;
  occurredAt: string;
}
const statusOf = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
const instant = (value: unknown, now: number) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return undefined;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis > now) return undefined;
  const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
  const offset =
    zone === null ? 0 : (zone[1] === "+" ? 1 : -1) * (Number(zone[2]) * 60 + Number(zone[3]));
  if (new Date(millis + offset * 60_000).toISOString().slice(0, 19) !== value.slice(0, 19))
    return undefined;
  return new Date(millis).toISOString();
};

/** A management HTTP status is never evidence of a vendor response. */
export function accountReadFailure(error: unknown, now: number): AccountFailureDetail {
  return {
    source:
      error instanceof HomeTransportFailure && error.errorClass !== "runtime_unhealthy"
        ? "transport"
        : "home",
    reason:
      error instanceof HomeTransportFailure && error.errorClass === "timeout"
        ? "timed_out"
        : "unavailable",
    occurredAt: new Date(now).toISOString(),
  };
}

/** Whitelist collector evidence; credentials, response text and request IDs stay internal. */
export function accountCollectionFailure(reading: Json, now: number): AccountFailureDetail {
  const credential = object(reading.credential) ? reading.credential : reading;
  const collection = object(reading.collection) ? reading.collection : credential;
  const error = object(collection.error) ? collection.error : {};
  const code = text(error.code);
  const status = statusOf(error.upstream_status_code);
  const occurredAt =
    instant(error.occurred_at, now) ??
    instant(collection.last_attempt_at, now) ??
    new Date(now).toISOString();
  const reason =
    code === "UPSTREAM_AUTH_REJECTED"
      ? "unauthorized"
      : code === "UPSTREAM_RATE_LIMITED"
        ? "rate_limited"
        : code === "UPSTREAM_RESPONSE_INVALID"
          ? "invalid_response"
          : "unavailable";
  const source =
    code === "UPSTREAM_UNAVAILABLE"
      ? status === undefined
        ? "transport"
        : "provider"
      : code === "UPSTREAM_AUTH_REJECTED" ||
          code === "UPSTREAM_RATE_LIMITED" ||
          code === "UPSTREAM_RESPONSE_INVALID"
        ? "provider"
        : "home";
  return {
    source,
    reason,
    ...(source === "provider" && status !== undefined ? { status } : {}),
    occurredAt,
  };
}
