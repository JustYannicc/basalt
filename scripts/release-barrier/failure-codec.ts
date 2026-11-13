import { Schema } from "effect";

const scalar = Schema.Union([Schema.String, Schema.Number, Schema.Null]);

/** Journal validation must retain the same safe diagnostics as the public receipt. */
export const failureCodec = Schema.Struct({
  reason: Schema.String,
  worker: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.String),
  provider: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      reason: Schema.optional(Schema.String),
      status: Schema.optional(Schema.Number),
      codes: Schema.optional(Schema.Array(Schema.Number)),
    }),
  ),
  delta: Schema.optional(
    Schema.Struct({
      fqn: Schema.String,
      type: Schema.String,
      changed: Schema.Array(
        Schema.Union([
          Schema.Struct({ path: Schema.String, old: scalar, new: scalar }),
          Schema.Struct({ path: Schema.String, changed: Schema.Literal(true) }),
        ]),
      ),
      why: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
