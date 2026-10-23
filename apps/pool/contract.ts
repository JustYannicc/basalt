// The pool control API between the pool app and the pool Worker.
// Base path: `/pool/v1` on the public host.
// Every request carries `Authorization: Bearer <pool token>`.
// Requests made for a person carry `X-Signalbox-Caller: <tools-service user id>`.
// Changes (starting a sign-in, pasting a callback, uploading a login file,
// polling a sign-in status, removing an account) are refused with 403 `not_owner` unless the caller owns the pool.

export const controlBasePath = "/pool/v1";
export const callerHeader = "x-signalbox-caller";

export function isControlPath(pathname: string): boolean {
  return pathname === controlBasePath || pathname.startsWith(`${controlBasePath}/`);
}

/** One provider the pool backend can sign in. Ids are the backend's own. */
export interface Provider {
  readonly id: string;
  readonly name: string;
}

/**
 * How a sign-in finishes, read from the backend's response, never from the provider:
 * - `callback`: the provider's page ends on a `localhost` address; the person pastes it back.
 * - `device`: the person approves on the provider's page and the backend finishes by itself.
 */
export type SignInFlow = "callback" | "device";

export interface UsageWindow {
  readonly id: string;
  /** The backend's label, such as "5 hours" or "Weekly". */
  readonly label: string;
  /** 0 to 1, or null when the backend doesn't know. */
  readonly remainingRatio: number | null;
  /** ISO time the window resets, or null. */
  readonly resetAt: string | null;
  /** Window length in seconds, or null. */
  readonly windowSeconds: number | null;
}

export type AccountState = "active" | "disabled" | "unavailable" | "error";

export interface Account {
  readonly id: string;
  readonly provider: string;
  /** The account's email or the backend's label for it. */
  readonly label: string;
  readonly plan: string | null;
  readonly state: AccountState;
  readonly message: string | null;
  readonly windows: readonly UsageWindow[];
  /** ISO time usage was last read, or null before the first read. */
  readonly observedAt: string | null;
}

/** GET /pool */
export interface PoolView {
  readonly isOwner: boolean;
  readonly providers: readonly Provider[];
  readonly accounts: readonly Account[];
}

/** One request recorded by Home. No client-key secrets or request contents are exposed. */
export interface UsageRecord {
  readonly id: string;
  /** Matches an account id in PoolView. */
  readonly account: string;
  readonly status: string;
  /** ISO timestamp. */
  readonly at: string;
}

/** Owner-only GET /usage?session=<wire X-Session-ID>&key=<Home API-key id>&limit=20&status=success.
 * At least session or key is required. Both filters are exact; neither includes child sessions.
 * The node files a request under `X-Session-ID` only when the request carries no session source it
 * ranks higher (such as a Claude Code session header), so send just `X-Session-ID` to find it here.
 */
export interface UsageResponse {
  readonly records: readonly UsageRecord[];
}

/** POST /sign-ins `{ provider }` */
export interface SignInStarted {
  /** Opaque, signed. Pass it back to the other sign-in calls. */
  readonly session: string;
  readonly provider: string;
  readonly flow: SignInFlow;
  /** The provider's sign-in or approval page. */
  readonly url: string;
  /** Shown to the person for device sign-ins that need a typed code. */
  readonly userCode: string | null;
  /** ISO time the backend forgets this sign-in. */
  readonly expiresAt: string;
}

/**
 * POST /sign-ins/callback `{ session, redirectUrl }` and GET /sign-ins/status?session=.
 * `connected` carries the account added to this pool.
 */
export type SignInStatus =
  | { readonly status: "waiting" }
  | { readonly status: "connected"; readonly accountId: string | null }
  | { readonly status: "failed"; readonly message: string };

/** DELETE /sign-ins?session= cancels. */

/** POST /login-files with the login file's JSON object as the body. */
export interface LoginFileAdded {
  readonly accountId: string;
}

/** DELETE /accounts/:id removes an account from this pool and the backend. */

export type ControlErrorCode =
  | "unauthorized"
  | "not_owner"
  | "unknown_provider"
  | "invalid_query"
  | "invalid_session"
  | "invalid_callback"
  | "invalid_login_file"
  | "not_found"
  | "backend_unavailable"
  | "busy";

export interface ControlError {
  readonly error: ControlErrorCode;
  readonly message: string;
}
