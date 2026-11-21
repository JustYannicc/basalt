import { State } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import type { CompiledStack } from "alchemy/Stack";
import { canonical, digest, BarrierRefusal } from "../../pool-fleet/manifest.ts";
import { openRecovery } from "../../pool-history/recovery-envelope.ts";
import { sqlSchemaReceiptCodec, homeMigrationReceiptCodec } from "./sql-schema-codec.ts";

const header = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  fingerprint: Schema.String,
  sealed: Schema.Unknown,
  previous: Schema.optional(Schema.Unknown),
});
const payload = Schema.Struct({
  receipt: sqlSchemaReceiptCodec,
  unresolvedHome: Schema.NullOr(homeMigrationReceiptCodec),
  lastConfirmedFailure: Schema.optional(homeMigrationReceiptCodec),
});
const location = (stack: Pick<CompiledStack, "name" | "stage">) => ({
  stack: `${stack.name}-sql-schema-barrier`,
  stage: stack.stage,
});
function open(value: unknown, key: string) {
  const parsed = Schema.decodeUnknownSync(header, { onExcessProperty: "error" })(value);
  const packet = Schema.decodeUnknownSync(payload, { onExcessProperty: "error" })(
    openRecovery(parsed.sealed, key, parsed.candidate, parsed.fingerprint),
  );
  if (
    packet.receipt.candidate !== parsed.candidate ||
    digest(
      canonical({
        candidate: packet.receipt.candidate,
        homeImageDigest: packet.receipt.homeImageDigest,
      }),
    ) !== parsed.fingerprint
  )
    throw new BarrierRefusal("sql-schema-journal-mismatch");
  return { header: parsed, ...packet };
}

/**
 * Reads the old layer's `<stack>-sql-schema-barrier` output. The cutover reads `unresolvedHome`
 * through this once: a non-null value means a Home schema step is in an unknown state.
 */
export const readSqlSchemaJournal = (stack: Pick<CompiledStack, "name" | "stage">, key: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const value = yield* state.getOutput(location(stack));
    return value === undefined ? undefined : open(value, key);
  });
