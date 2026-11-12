import { Schema } from "effect";

/** A partial catalog cannot establish that no tools match the query. */
export const readToolSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({ path: Schema.String, description: Schema.String, input: Schema.String }),
    ),
    remaining: Schema.Number,
    next: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    unavailableApps: Schema.Array(
      Schema.Struct({
        app: Schema.String,
        name: Schema.String,
        reason: Schema.String,
        router: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);
