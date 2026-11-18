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
    poolContainer: Schema.Struct({ fqn: poolContainer.fields.fqn, image: Schema.Literal("") }),
  }),
  include: Schema.optional(Schema.Array(Schema.String)),
  wire: Schema.Struct({
    sqliteClasses: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    expectLiveModule: Schema.optional(Schema.Array(Schema.String)),
  }),
  // Only the cutover's declaration switches; a policy never supplies other configuration.
  env: Schema.Struct({
    POOL_FLEET_BUILD: Schema.optional(Schema.Literal("true")),
    POOL_FLEET_CLASSES: Schema.optional(Schema.Literal("absent")),
    POOL_WORKER_VERSION_TRAFFIC: Schema.optional(Schema.String),
  }),
});
export type ReleasePolicy = typeof ReleasePolicy.Type;

export const decodeReleasePolicy = Schema.decodeUnknownSync(ReleasePolicy, {
  onExcessProperty: "error",
});
