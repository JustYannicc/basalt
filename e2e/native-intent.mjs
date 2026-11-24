import { setupIntentPrefix, signEnvelope } from "../src/pool/token.ts";

/** The key the proof's server and its pool stand-in share as `POOL_APP_SIGNING_KEY`. */
export const proofSigningKey = "ab".repeat(32);

/**
 * The Connect page's setup intent for `actor`, signed as the pool signs one. The pool stand-in
 * and the tools host refuse an unsigned intent, so an approval needs a fresh one each time.
 */
export const setupIntentFor = (actor, pool) =>
  signEnvelope(proofSigningKey, setupIntentPrefix, {
    user: actor.userId,
    pool,
    owner: actor.userId,
    organization: actor.organizationId,
    expiresAt: Date.now() + 60_000,
  });
