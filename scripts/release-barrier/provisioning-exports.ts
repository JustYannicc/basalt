import { decodeProvisioningInput } from "./provisioning-refusal.ts";
import { Schema } from "effect";

const name = Schema.NonEmptyString;
const state = Schema.optionalKey(Schema.Literal("created"));
// The pinned SDK declares this dictionary as one export. Decode its actual map at the boundary.
export const RuntimeExports = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("worker"),
      state,
      cache: Schema.optionalKey(
        Schema.Struct({
          enabled: Schema.optionalKey(Schema.Boolean),
          crossVersionCache: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
    Schema.Struct({
      type: Schema.Literal("durable-object"),
      storage: Schema.Literals(["sqlite", "legacy-kv"]),
      container: Schema.optionalKey(name),
      state,
    }),
  ]),
);
export const readRuntimeExports = decodeProvisioningInput(RuntimeExports, "namespace.exports");
