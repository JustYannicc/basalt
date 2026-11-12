import { State, type StateService } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import type { CompiledStack } from "alchemy/Stack";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import { openRecovery, sealRecovery } from "./recovery-envelope.ts";
import { sqlSchemaReceiptCodec, homeMigrationReceiptCodec } from "./sql-schema-codec.ts";
import type { SqlSchemaReceipt } from "./sql-schema-contract.ts";
import {
  confirmedHomeMigrationResult,
  type HomeMigrationReceipt,
} from "./home-schema-operation.ts";

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

/** Independent of container rollout journals, including Worker-only releases. */
export const readSqlSchemaJournal = (stack: Pick<CompiledStack, "name" | "stage">, key: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const value = yield* state.getOutput(location(stack));
    return value === undefined ? undefined : open(value, key);
  });

function sameHomeIdentity(current: HomeMigrationReceipt, prior: HomeMigrationReceipt) {
  return (
    current.imageDigest === prior.imageDigest &&
    current.imageConfigDigest === prior.imageConfigDigest &&
    current.sourceInputHash === prior.sourceInputHash &&
    current.targetVersion === prior.targetVersion &&
    current.expectedIndexes.length === prior.expectedIndexes.length &&
    new Set(current.expectedIndexes).size === current.expectedIndexes.length &&
    current.expectedIndexes.every((name) => prior.expectedIndexes.includes(name))
  );
}

function settled(current: HomeMigrationReceipt, prior: HomeMigrationReceipt) {
  return (
    sameHomeIdentity(current, prior) &&
    (current.intentId === prior.intentId || current.priorIntentId === prior.intentId) &&
    current.after?.target_version === prior.targetVersion &&
    current.after.applied_version === prior.targetVersion &&
    current.after.indexes_checked &&
    current.after.pending_indexes.length === 0 &&
    ["ready", "migrated", "noop"].includes(current.after.status)
  );
}

export const writeSqlSchemaJournal = (
  state: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
  key: string,
  receipt: SqlSchemaReceipt,
) =>
  Effect.gen(function* () {
    const safe = Schema.decodeUnknownSync(sqlSchemaReceiptCodec, { onExcessProperty: "error" })(
      receipt,
    );
    const priorValue = yield* state.getOutput(location(stack));
    const prior = priorValue === undefined ? undefined : open(priorValue, key);
    let unresolvedHome = prior?.unresolvedHome ?? null;
    let lastConfirmedFailure = prior?.lastConfirmedFailure;
    const migration = safe.homeMigration;
    if (migration) {
      if (migration.state === "failed" && confirmedHomeMigrationResult(migration)) {
        if (
          unresolvedHome &&
          (unresolvedHome.intentId !== migration.intentId ||
            !sameHomeIdentity(migration, unresolvedHome))
        )
          throw new BarrierRefusal(
            "home-schema-prior-intent-unsettled",
            `home required=${unresolvedHome.targetVersion}`,
          );
        unresolvedHome = null;
        lastConfirmedFailure = migration;
      } else if (["intent", "unknown", "failed"].includes(migration.state)) {
        if (unresolvedHome && unresolvedHome.intentId !== migration.intentId)
          throw new BarrierRefusal(
            "home-schema-prior-intent-unsettled",
            `home required=${unresolvedHome.targetVersion}`,
          );
        unresolvedHome = migration;
      } else if (["skipped", "migrated", "noop"].includes(migration.state) && unresolvedHome) {
        if (!settled(migration, unresolvedHome))
          throw new BarrierRefusal(
            "home-schema-prior-intent-unsettled",
            `home required=${unresolvedHome.targetVersion}`,
          );
        unresolvedHome = null;
      }
    }
    const fingerprint = digest(
      canonical({ candidate: safe.candidate, homeImageDigest: safe.homeImageDigest }),
    );
    const previous =
      prior &&
      (prior.header.candidate !== safe.candidate || prior.header.fingerprint !== fingerprint)
        ? {
            schemaVersion: prior.header.schemaVersion,
            candidate: prior.header.candidate,
            fingerprint: prior.header.fingerprint,
            sealed: prior.header.sealed,
          }
        : prior?.header.previous;
    return yield* state.setOutput({
      ...location(stack),
      value: {
        schemaVersion: 1,
        candidate: safe.candidate,
        fingerprint,
        sealed: sealRecovery(
          {
            receipt: safe,
            unresolvedHome,
            ...(lastConfirmedFailure ? { lastConfirmedFailure } : {}),
          },
          key,
          safe.candidate,
          fingerprint,
        ),
        ...(previous ? { previous } : {}),
      },
    });
  });
