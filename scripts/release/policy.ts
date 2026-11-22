import { Schema } from "effect";
import { PlanPolicy } from "./plan-check.ts";

const { poolContainer, ...checkFields } = PlanPolicy.fields;

/**
 * A reviewed policy file in `scripts/release/policies`. Our own input, so every key is known: a
 * misspelt guard (say `expectLiveModules`) fails the run instead of silently switching it off.
 */
export const ReleasePolicy = Schema.Struct({
  description: Schema.String,
  check: Schema.Struct({
    ...checkFields,
    // The pin carries the account id, so the file leaves it empty and the run supplies it.
    poolContainer: Schema.Struct({
      fqn: poolContainer.fields.fqn,
      image: Schema.Literal(""),
      imageRelease: poolContainer.fields.imageRelease,
      recordedHashOnly: poolContainer.fields.recordedHashOnly,
      workerAttachment: poolContainer.fields.workerAttachment,
    }),
  }),
  include: Schema.optional(Schema.Array(Schema.String)),
  wire: Schema.Struct({
    sqliteClasses: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    expectLiveModule: Schema.optional(Schema.Array(Schema.String)),
    /** FQNs admitted as code-only changes: their uploads keep the serving version's bindings. */
    fixedBindings: Schema.optional(Schema.Array(Schema.String)),
  }),
  /**
   * A release that declares the root will restart, because its own code restarts a runtime that
   * runs but refuses. Acceptance waits for the new boot within this bound, then requires every
   * request on it; a failure is not rolled back to code that could not heal the pool.
   */
  acceptance: Schema.optional(
    Schema.Struct({
      rootRestart: Schema.Struct({
        bound: Schema.Literal("healingAcceptanceWithinMs"),
        why: Schema.String,
      }),
    }),
  ),
  /**
   * Secrets a failed release's rollback may force past Cloudflare's refusal while a secret differs
   * from the value the earlier version ran with (10220): ones that differ on every release by
   * design. The rollback forces only a refusal that names nothing else; a policy without it forces
   * nothing.
   */
  rollback: Schema.optional(
    Schema.Struct({
      forceSecrets: Schema.NonEmptyArray(
        Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
      ),
      why: Schema.NonEmptyString,
    }),
  ),
  // Only the cutover's declaration switches; a policy never supplies other configuration.
  env: Schema.Struct({
    POOL_FLEET_BUILD: Schema.optional(Schema.Literal("true")),
    POOL_FLEET_CLASSES: Schema.optional(Schema.Literal("absent")),
  }),
});
export type ReleasePolicy = typeof ReleasePolicy.Type;

export const decodeReleasePolicy = Schema.decodeUnknownSync(ReleasePolicy, {
  onExcessProperty: "error",
});
