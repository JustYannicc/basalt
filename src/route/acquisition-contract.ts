/**
 * The tools service's route-acquisition driver and the Basalt Worker's receiver share this wire.
 * Both sides keep a byte-identical copy (src/route/acquisition-contract.ts in Basalt and
 * apps/hosted/server/src/implementation/route-acquisition-contract.ts in the carry); a test fails
 * when they differ. It has no imports, so it runs unchanged in the Worker and the tools service.
 *
 * Every request is one POST of `{"envelope": "<signEnvelope(POOL_APP_SIGNING_KEY, prefix, claims)>"}`
 * to `routeAcquisitionPath`. The envelope expires at most 30 s after `at`. The receiver also opens
 * envelopes signed with POOL_APP_SIGNING_KEY_PREVIOUS. Names of tailnets, devices and exits appear
 * only in successful responses; errors carry reason codes only.
 */
export const routeAcquisitionPath = "/route/v1/acquisitions";
export const routeAcquisitionPrefix = "sbra1";

/** `rt_` plus 26 base32 characters, assigned by the driver at start and never reused. */
export const routeIdPattern = /^rt_[a-z2-7]{26}$/u;

/**
 * The person a route belongs to: `org/<organization id>/user/<user id>`. Shaped so a level can be
 * added later (`org/<id>/folder/<id>`). P3's resolveForAccount returns this same string.
 */
export const routeOwnerPattern = /^org\/[^/]+\/user\/[^/]+$/u;

export const routeReasons = [
  "route_off",
  "route_needs_login",
  "route_key_expired",
  "route_not_selected",
  "route_exit_missing",
  "route_exit_offline",
  "route_exit_unreachable",
  "route_policy_denied",
  "route_status_unavailable",
  "route_gateway_unavailable",
  "route_not_permitted",
] as const;
export type RouteReason = (typeof routeReasons)[number];
export type RouteWhenDown = "stop" | "direct";

/** I2 `Reading`. */
export interface RouteReading {
  readonly state: "active" | "down" | "direct_fallback" | "off" | "needs_login";
  readonly reason: RouteReason | null;
  readonly exitName: string | null;
  readonly path: "direct" | "relay" | "unknown";
  readonly relayRegion: string | null;
  readonly checkedAt: number;
  readonly whenDown: RouteWhenDown;
  readonly tailnet: string | null;
  /** Milliseconds since the epoch when `state` last changed. */
  readonly since: number;
  /** This route's own node name on the tailnet. */
  readonly deviceName: string | null;
  /** This route's own node id, the one the Tailscale API knows the device by. */
  readonly deviceId: string | null;
  /** Milliseconds since the epoch when the node key expires; null when it does not or is unknown. */
  readonly keyExpiry: number | null;
}

interface Signed {
  readonly at: number;
  readonly expiresAt: number;
  readonly routeId: string;
}

/**
 * Sign-in steps, sent while a person is connecting. `owner` comes from the tools service's
 * authenticated caller; the receiver stores it on `start` and refuses any later mismatch.
 */
export type RouteSessionClaims = Signed &
  (
    | { readonly action: "start"; readonly owner: string; readonly app: string }
    | { readonly action: "status" | "cancel"; readonly owner: string }
  );

/**
 * Steps on a saved account. A background check has no person, so these carry the organization and
 * the account instead of the owner: the receiver binds `account` the first time it sees one, then
 * refuses another account or another organization with `route_not_permitted`.
 */
export type RouteAccountClaims = Signed & {
  readonly organization: string;
  readonly account: string;
} & (
    | { readonly action: "check" | "reading" | "exits" | "remove" }
    | {
        readonly action: "select";
        readonly exitId: string | null;
        readonly whenDown: RouteWhenDown;
      }
  );

export type RouteAcquisitionClaims = RouteSessionClaims | RouteAccountClaims;

/** Success bodies, status 200, by action. */
export interface RouteAcquisitionReplies {
  /** I2 `create` then `login`. `expiresAt` is when the approval link stops working. */
  readonly start: { readonly url: string; readonly expiresAt: number };
  /** `connected` once the node has an identity; the receiver persists its state first. */
  readonly status:
    | { readonly state: "waiting" }
    | { readonly state: "connected"; readonly tailnet: string | null }
    | { readonly state: "failed"; readonly reason: RouteReason };
  /** I2 `disconnect`: the device leaves the tailnet and its stored state is deleted. Idempotent. */
  readonly cancel: Record<string, never>;
  readonly remove: Record<string, never>;
  readonly check: { readonly reading: RouteReading };
  readonly reading: { readonly reading: RouteReading };
  /** I2 `exits`, plus the route's current selection so a picker shows what is chosen. */
  readonly exits: {
    readonly exits: readonly {
      readonly id: string;
      readonly name: string;
      readonly online: boolean;
      /** Milliseconds since the epoch the exit was last seen; null while online or unknown. */
      readonly lastSeen: number | null;
    }[];
    readonly selected: { readonly exitId: string | null; readonly whenDown: RouteWhenDown };
  };
  /** I2 `select`; `exitId: null` switches routing off for this route. */
  readonly select: { readonly reading: RouteReading };
}

/** Failure bodies: 400 `bad_request`, 403 `route_not_permitted`, 503 `route_gateway_unavailable`. */
export interface RouteAcquisitionFailure {
  readonly error: "bad_request" | "route_not_permitted" | "route_gateway_unavailable";
}
