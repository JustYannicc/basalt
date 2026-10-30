// The computer and pool shapes the pool Worker and the setup host share.
// Structural on purpose: the page never imports the server, and it never sees a
// computer's model key or tools token. Those only travel behind the one-time link.

/** One computer the signed-in person set up, bound to the pool chosen for it. */
export interface Computer {
  readonly id: string;
  /** The person's own name for it, such as "Work laptop". */
  readonly name: string;
  readonly poolId: string;
  /** ISO time the computer was created. */
  readonly createdAt: string;
  /** ISO time its first real model request reached the pool, or null. */
  readonly firstModelRequestAt: string | null;
  /** ISO time its first real tool call reached the tools service, or null. */
  readonly firstToolCallAt: string | null;
  /** ISO time it was revoked, or null while it still works. */
  readonly revokedAt: string | null;
  /**
   * ISO time its model key was deleted because the person lost access to its pool, or null.
   * Its tools token stays theirs until they revoke the computer.
   */
  readonly removedAt?: string | null;
  /**
   * The host's lifecycle, when it reports one. `issuing`: its link is out and
   * unclaimed. `revoking`: revoke started but hasn't finished, so it may still work.
   * `removed`: the person lost access to its pool, so its model requests fail.
   */
  readonly state?: ComputerState;
  /** False for a computer set up for models only. Absent from hosts that predate the choice. */
  readonly tools?: boolean;
  /** Its setup link lapsed unclaimed, so it can never be set up. */
  readonly lapsed?: true;
}

export type ComputerState = "issuing" | "active" | "revoking" | "revoked" | "removed";

/** A pool the person can point a computer at: their own, or one shared with them. */
export interface PoolChoice {
  readonly id: string;
  /** The pool app's name, such as "Ada's pool". */
  readonly name: string;
  /** True for the person's own pool. */
  readonly mine: boolean;
}

/** Same shape as the pool API's own results, so its calls fit without adapting. */
export type ComputerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly message: string };
