// Pool access changes, from the tools service to the pool Worker.
// The tools service decides who can use a pool app. Whenever that can shrink or grow, it tells the
// pool Worker the pool's new audience before its own change commits. The pool Worker revokes the
// computer keys of everyone who lost access, and tries to create the pool backend user of everyone
// who gained it. Failed provisioning stays pending; first mint can create the user lazily.
// A non-2xx answer means the change must not commit; the person can retry.
// This file imports nothing: the bundler copies it into the tools service as is.

/** `POST /pool/v1/access` with JSON `{ envelope }`. */
export const accessPath = "/pool/v1/access";
/** Envelope kind, signed with `POOL_APP_SIGNING_KEY` through `signEnvelope` in token.ts. */
export const accessPrefix = "sba1";
/** The pool Worker refuses envelopes that expire later than this from now. */
export const accessTtl = 30_000;
/**
 * After someone loses access, setup intents for that pool and person issued before
 * `now + accessGrace` are refused. That covers tool calls the tools service authorized just before
 * the removal committed and that reach the pool Worker after it.
 */
export const accessGrace = 60_000;

/** One pool app and everyone who can use it once the change commits. */
export interface PoolAudience {
  /** The pool app's id; the `pool` claim of its pool token. */
  readonly pool: string;
  /** The pool's owner; always allowed, whether listed or not. */
  readonly owner: string;
  readonly organization: string;
  /** The app's display name, such as "Ada's pool". */
  readonly name: string;
  /** Tools-service user ids with use access after the change, owner included. */
  readonly users: readonly string[];
}

export type AccessChange =
  /** Sharing, groups or membership changed. Every listed pool gets its full new audience. */
  | { readonly action: "audience"; readonly pools: readonly PoolAudience[] }
  /** The pool app is being deleted: revoke every key bound to it. */
  | { readonly action: "pool-deleted"; readonly pool: string }
  /** The person's account is being deleted: revoke all their keys and delete their backend user. */
  | { readonly action: "person-deleted"; readonly user: string };

/** The signed payload. `at` orders audiences per pool; deletions always apply. Refusals reject older projections. */
export type AccessEnvelope = AccessChange & { readonly at: number; readonly expiresAt: number };

/** 200 body. Sent after every revocation succeeded; provisioning is best-effort. */
export interface AccessApplied {
  /** Computer keys deleted on the pool backend by this change. */
  readonly revoked: number;
  /** Pool backend users created by this change. */
  readonly provisioned: number;
}
