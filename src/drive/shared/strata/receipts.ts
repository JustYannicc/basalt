import * as Schema from "effect/Schema";
import type { Receipt } from "./types.js";

const common = { operation: Schema.String, ref: Schema.String, oid: Schema.String };
const conflict = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["content", "unsupported"]),
  base: Schema.NullOr(Schema.String),
  ours: Schema.String,
  theirs: Schema.String,
  baseBlob: Schema.NullOr(Schema.String),
  oursBlob: Schema.NullOr(Schema.String),
  theirsBlob: Schema.NullOr(Schema.String),
});
export const receiptSchema = Schema.Union([
  Schema.Struct({ ...common, state: Schema.Literal("opened") }),
  Schema.Struct({ ...common, state: Schema.Literal("saved") }),
  Schema.Struct({ ...common, state: Schema.Literal("landed"), previous: Schema.String }),
  Schema.Struct({
    ...common,
    state: Schema.Literal("conflict"),
    main: Schema.String,
    conflicts: Schema.Array(conflict),
  }),
]);

export const decodeReceipt = (value: unknown): Receipt =>
  Schema.decodeUnknownSync(receiptSchema)(value);
