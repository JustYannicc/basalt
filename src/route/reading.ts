import { Schema } from "effect";
import { routeReasons, type RouteReading } from "./acquisition-contract.ts";

export const ReasonCode = Schema.Literals(routeReasons);
export type ReasonCode = typeof ReasonCode.Type;
export const WhenDown = Schema.Literals(["stop", "direct"]);
export type WhenDown = typeof WhenDown.Type;

/** The gateway's I1 `/status` body. Unknown fields are tolerated so the image can grow. */
export const GatewayStatus = Schema.Struct({
  boot_id: Schema.String,
  state: Schema.Literals(["needs_login", "ready", "down", "direct_fallback"]),
  reason: Schema.NullOr(ReasonCode),
  when_down: WhenDown,
  exit: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      online: Schema.Boolean,
      path: Schema.Literals(["direct", "relay", "unknown"]),
      relay_region: Schema.NullOr(Schema.String),
    }),
  ),
  node: Schema.Struct({
    logged_in: Schema.Boolean,
    key_expiry: Schema.NullOr(Schema.String),
    tailnet: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  state_revision: Schema.Number,
});
export type GatewayStatus = typeof GatewayStatus.Type;

export type Reading = RouteReading;

export interface Selection {
  exitId: string | null;
  whenDown: WhenDown;
}

export function readingFromStatus(status: GatewayStatus, checkedAt: number): Reading {
  const state =
    status.reason === "route_off"
      ? "off"
      : status.state === "ready"
        ? "active"
        : status.state === "needs_login"
          ? "needs_login"
          : status.state;
  return {
    state,
    reason: state === "active" ? null : (status.reason ?? "route_status_unavailable"),
    exitName: status.exit?.name ?? null,
    tailnet: status.node.tailnet ?? null,
    path: status.exit?.path ?? "unknown",
    relayRegion: status.exit?.relay_region ?? null,
    checkedAt,
    whenDown: status.when_down,
  };
}

/** What a caller sees when the DO cannot read the gateway, or has nothing to read yet. */
export function localReading(
  state: Reading["state"],
  reason: ReasonCode,
  selection: Selection | undefined,
  checkedAt: number,
): Reading {
  return {
    state,
    reason,
    exitName: null,
    tailnet: null,
    path: "unknown",
    relayRegion: null,
    checkedAt,
    whenDown: selection?.whenDown ?? "stop",
  };
}

/** Only crossing into or out of `down` is worth a person's attention (the Blocker and the badge). */
export function crossesDown(previous: Reading | undefined, next: Reading) {
  return (previous?.state === "down") !== (next.state === "down");
}

export interface RouteReadingChanged {
  event: "route.reading.changed";
  routeId: string;
  state: Reading["state"];
  reason: ReasonCode | null;
}

/** Carries reason codes only: exit, device and tailnet names never leave the owner's own reads. */
export function routeReadingChanged(routeId: string, reading: Reading): RouteReadingChanged {
  return { event: "route.reading.changed", routeId, state: reading.state, reason: reading.reason };
}

let sink: ((event: RouteReadingChanged) => void) | undefined;
/** Where the Blocker and the badge subscribe. Slice 1 has no subscriber; the log line always goes out. */
export function onRouteReadingChanged(next: ((event: RouteReadingChanged) => void) | undefined) {
  sink = next;
}
export function emitRouteReadingChanged(event: RouteReadingChanged) {
  console.log(JSON.stringify(event));
  sink?.(event);
}
