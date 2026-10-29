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
  /** ISO time this window was last read, or null; windows of one account can be read at different times. */
  readonly observedAt: string | null;
}

export type AccountState = "active" | "disabled" | "unavailable" | "error";

/** How current the account's limit reading is: `never` before its first reading. */
export type ReadingFreshness = "fresh" | "stale" | "never";

/** Provider-issued resets the account can use, such as Codex reset credits or Claude reset grants. */
export interface BankedResets {
  readonly available: number;
  /** ISO time the next one expires, or null when none expires or the provider doesn't say. */
  readonly nextExpiresAt: string | null;
}

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
  /** Whether that reading is still current; a stale one keeps its last-known windows. */
  readonly freshness: ReadingFreshness;
  /** True when the last attempt to read limits failed, even if older readings remain. */
  readonly readingFailed: boolean;
  /** A current runtime credential refusal, kept separate from quota exhaustion or routing cooldown. */
  readonly credentialFailure?: "unauthorized" | "unavailable";
  /** Home's last collection outcome, without diagnostic messages or response data. */
  readonly collection?: {
    readonly status: string | null;
    readonly errorCode: string | null;
    readonly lastAttemptAt: string | null;
  };
  /** ISO time the backend reads it again, or null. */
  readonly nextReadAt: string | null;
  /** The soonest reset across all of the account's windows, or null. */
  readonly earliestResetAt: string | null;
  /** Null when the provider reports none or doesn't support them. */
  readonly bankedResets: BankedResets | null;
  /**
   * Set by the pool app, not the Worker: the app's Accounts tab holds this subscription, so it's
   * removed there. Accounts added before the tab could connect them have none.
   */
  readonly inAccounts?: boolean;
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

/** Tokens the way Home counts them. `total` is every token, including cached input. */
export interface TokenCounts {
  /** Input sent at the full rate. */
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Output, reasoning included. */
  readonly output: number;
  readonly total: number;
}

/** One slice of usage. `cost` is the API-equivalent price in US dollars; unpriced requests add nothing to it. */
export interface UsageSlice {
  readonly requests: number;
  readonly tokens: TokenCounts;
  readonly cost: number;
  /** Requests whose model had no price, so `cost` leaves them out. */
  readonly unpriced: number;
}

export interface ModelUsage extends UsageSlice {
  /** Home's provider id for the account that served it, such as `claude`. */
  readonly provider: string;
  readonly model: string;
}

/** One UTC day, `YYYY-MM-DD`, with its models. */
export interface DayUsage extends UsageSlice {
  readonly day: string;
  readonly models: readonly ModelUsage[];
}

/**
 * A member's optional spending cap on this pool, enforced by the pool backend's spend limits.
 * Calendar weeks, Monday 00:00 UTC. The request that crosses it finishes; the next one is refused.
 */
export interface Cap {
  /** US dollars of API-equivalent cost per week. */
  readonly weekly: number;
  readonly used: number;
  readonly remaining: number;
  /** ISO time it resets. */
  readonly resetAt: string;
}

export interface AccountUsage extends UsageSlice {
  readonly account: string;
}

/** Per member, for the pool's owner only. `member` is the tools-service user id. */
export interface MemberUsage extends UsageSlice {
  readonly member: string;
  /** Only this member's requests, per model and per UTC day. */
  readonly models: readonly ModelUsage[];
  readonly days: readonly DayUsage[];
  /** Null when no cap is set, which is the default. */
  readonly cap: Cap | null;
}

/**
 * Whether a provider's accounts are enough, from how often they hit their limits in the last 7 days:
 * - `add`: every account was at a limit at once, so requests had nowhere to go;
 * - `remove`: no account hit a limit and the rest always had at least one account's worth left;
 * - `enough`: anything in between;
 * - `unknown`: under a day of readings.
 */
export type AccountsAdvice = "add" | "remove" | "enough" | "unknown";
export interface AccountsNeeded {
  readonly provider: string;
  readonly advice: AccountsAdvice;
  readonly accounts: number;
  /** Separate times an account reached a limit, over the period read. */
  readonly limitHits: number;
  /** Share of readings with every account at a limit, 0 to 1. */
  readonly exhausted: number;
  /** Hours of readings behind the advice. */
  readonly hoursRead: number;
}

/** The usage views cover this many days, the most a summary can ask for. */
export const usageDays = 30;

/**
 * GET /usage/summary?days=30 (1 to 30). The owner sees the whole pool, per member and the accounts
 * needed. Anyone else sees only their own usage on this pool and their own cap; `members` and
 * `accountsNeeded` are absent, never empty placeholders. Days with no usage are left out.
 */
export interface UsageSummary {
  readonly scope: "pool" | "you";
  /** ISO start, inclusive, and end, exclusive. */
  readonly from: string;
  readonly to: string;
  readonly total: UsageSlice;
  readonly models: readonly ModelUsage[];
  readonly days: readonly DayUsage[];
  readonly members?: readonly MemberUsage[];
  /**
   * Per account in this pool (`account` matches `Account.id`). The owner gets everyone's requests;
   * anyone else only their own, split by the account that served them.
   */
  readonly accounts: readonly AccountUsage[];
  readonly accountsNeeded?: readonly AccountsNeeded[];
  /** The caller's own cap on this pool; always null for the owner. */
  readonly cap: Cap | null;
  /** ISO time the pool last read Home's records, or null before the first read. */
  readonly readAt: string | null;
}

export const maxWeeklyCap = 100_000;

/** Whole cents, more than nothing and at most `maxWeeklyCap` US dollars a week. */
export function isWeeklyCap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maxWeeklyCap
    && Math.round(value * 100) / 100 === value;
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

/** Owner-only GET /accounts/:id/export?provider=claude|codex.
 * Uses the existing signed pool token and owner caller header, including for opaque native app ids.
 * The exact account must belong to that pool and match the provider. Returns the unmodified Home
 * login-file JSON object, with no Result wrapper and Cache-Control: no-store. Maximum 1 MiB.
 * Bad selectors return 400 invalid_query; absent/wrong-pool/wrong-provider accounts return 404
 * not_found. Invalid auth returns 401 unauthorized or 403 not_owner; backend failures return
 * sanitized 503 backend_unavailable. The route neither imports nor refreshes subscriptions.
 * The protected Actions exporter owns dedicated-account confirmation and repository secret writes.
 * This is a direct control endpoint, not a tool exposed by the installed pool app.
 */

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
