import { Schema } from "effect";
import { policyHeader, policyUsePrefix } from "../membership-contract.ts";
import { openEnvelope, signEnvelope } from "../token.ts";

const Assertion = Schema.Struct({
  pool: Schema.String,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  expiresAt: Schema.Number,
});
/** The controller checks current authority; each retained runtime verifies its own startup key. */
export async function runtimePolicyAssertion(
  headers: Headers,
  keys: { current: string; previous?: string; runtime: string },
) {
  const assertion = headers.get(policyHeader);
  if (!assertion) return;
  const claims = Schema.decodeUnknownSync(Assertion)(
    await openEnvelope(keys.current, policyUsePrefix, assertion, keys.previous),
  );
  if (claims.expiresAt <= Date.now()) throw new Error("Pool assertion expired");
  headers.set(policyHeader, await signEnvelope(keys.runtime, policyUsePrefix, claims));
}
