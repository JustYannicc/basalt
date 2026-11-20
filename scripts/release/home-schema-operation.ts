import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import type { HomeSchemaProof } from "./sql-schema-contract.ts";
import { changedHomeMigrationConditions, validHomeRetryIntent } from "./home-schema-retry.ts";

const indexName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,127}$/u));
const version = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const infoCodec = Schema.Struct({
  format_version: Schema.Literal(1),
  target_version: version,
  required_indexes: Schema.Array(indexName).check(Schema.isMaxLength(128)),
});
export const nativeHomeReasonCodes = [
  "invalid_mode",
  "configuration_failed",
  "postgres_configuration_required",
  "postgres_required",
  "database_open_failed",
  "database_handle_failed",
  "database_close_failed",
  "schema_read_failed",
  "schema_uninitialized",
  "schema_ahead",
  "schema_pending",
  "indexes_pending",
  "index_read_failed",
  "index_definition_mismatch",
  "migration_failed",
] as const;
const resultCodec = Schema.Struct({
  format_version: Schema.Literal(1),
  target_version: version,
  previous_version: Schema.NullOr(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
  applied_version: Schema.NullOr(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
  status: Schema.Literals(["ready", "pending", "refused", "failed", "migrated", "noop"]),
  indexes_checked: Schema.Boolean,
  pending_indexes: Schema.Array(indexName).check(Schema.isMaxLength(128)),
  reason: Schema.optional(Schema.Literals(nativeHomeReasonCodes)),
  sqlstate: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z0-9]{5}$/u))),
});
export const homeSchemaResultCodec = resultCodec;
export type HomeSchemaInfo = typeof infoCodec.Type;
export type HomeSchemaResult = typeof resultCodec.Type;

export class HomeSchemaCommandError extends Error {
  readonly containerId?: string;
  readonly reason:
    | "command-failed"
    | "command-timeout"
    | "invalid-receipt"
    | "image-mismatch"
    | "pull-failed"
    | "cleanup-failed";
  constructor(reason: HomeSchemaCommandError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}
export function decodeHomeSchemaInfo(value: unknown): HomeSchemaInfo {
  try {
    const info = Schema.decodeUnknownSync(infoCodec, { onExcessProperty: "error" })(value);
    if (new Set(info.required_indexes).size !== info.required_indexes.length) throw new Error();
    return info;
  } catch {
    throw new HomeSchemaCommandError("invalid-receipt");
  }
}
export function decodeHomeSchemaResult(value: unknown, info: HomeSchemaInfo): HomeSchemaResult {
  try {
    const result = Schema.decodeUnknownSync(resultCodec, { onExcessProperty: "error" })(value);
    if (
      result.target_version !== info.target_version ||
      new Set(result.pending_indexes).size !== result.pending_indexes.length ||
      result.pending_indexes.some((name) => !info.required_indexes.includes(name))
    )
      throw new Error();
    return result;
  } catch {
    throw new HomeSchemaCommandError("invalid-receipt");
  }
}

export interface HomeMigrationIdentity {
  candidate: string;
  imageDigest: string;
  imageConfigDigest: string;
  baselineImageDigest: string;
  sourceInputHash: string;
  baselineInputHash: string;
}
export interface HomeMigrationReceipt extends HomeMigrationIdentity {
  targetVersion: number;
  expectedIndexes: readonly string[];
  state: "skipped" | "intent" | "migrated" | "noop" | "refused" | "failed" | "unknown";
  before: HomeSchemaResult | null;
  after: HomeSchemaResult | null;
  nativeResult?: HomeSchemaResult;
  intentId?: string;
  priorIntentId?: string;
  containerId?: string;
  reason?:
    | NonNullable<HomeSchemaResult["reason"]>
    | HomeSchemaCommandError["reason"]
    | "native-readiness-unreadable"
    | "unreviewed-transition"
    | "native-migration-incomplete"
    | "prior-image-intent-unsettled"
    | "prior-intent-unsettled"
    | "prior-failure-unchanged"
    | "retry-authorization-invalid";
  at: string;
}
export interface NativeHomeCommands {
  check(): Promise<HomeSchemaResult>;
  migrate(allocated?: (containerId: string) => Promise<void>): Promise<HomeSchemaResult>;
}
export type HomeMigrationAdmission = (
  identity: HomeMigrationIdentity,
  info: HomeSchemaInfo,
  before: HomeSchemaResult,
) => boolean;

export function confirmedHomeMigrationResult(receipt: HomeMigrationReceipt) {
  const result = receipt.nativeResult;
  return (
    result !== undefined &&
    result.target_version === receipt.targetVersion &&
    ["migrated", "noop", "refused", "failed"].includes(result.status) &&
    receipt.reason !== "cleanup-failed"
  );
}

function ready(result: HomeSchemaResult, info: HomeSchemaInfo) {
  return (
    (result.status === "ready" || result.status === "migrated" || result.status === "noop") &&
    result.target_version === info.target_version &&
    result.applied_version === info.target_version &&
    result.indexes_checked &&
    result.pending_indexes.length === 0
  );
}
function proof(
  identity: HomeMigrationIdentity,
  info: HomeSchemaInfo,
  result: HomeSchemaResult | null,
  successful: boolean,
): HomeSchemaProof {
  const checked = result?.indexes_checked === true;
  return {
    imageDigest: identity.imageDigest,
    targetVersion: info.target_version,
    expectedIndexes: [...info.required_indexes],
    readyIndexes: checked
      ? info.required_indexes.filter((name) => !result!.pending_indexes.includes(name))
      : null,
    pendingIndexes: checked ? [...result!.pending_indexes] : null,
    status: successful
      ? "ready"
      : result?.status === "pending"
        ? "pending"
        : result?.status === "refused"
          ? "incompatible"
          : "unreadable",
    observedAt: new Date().toISOString(),
  };
}

/** A write has one recorded intent and one invocation. Reconciliation never repeats that invocation. */
export async function prepareHomeSchema(options: {
  identity: HomeMigrationIdentity;
  info: HomeSchemaInfo;
  commands: NativeHomeCommands;
  admit: HomeMigrationAdmission;
  prior?: HomeMigrationReceipt;
  lastFailure?: HomeMigrationReceipt;
  retryIntentId?: string;
  record(receipt: HomeMigrationReceipt): Promise<void>;
}) {
  const { identity, info } = options;
  let before: HomeSchemaResult | null = null;
  let initialFailure: HomeSchemaCommandError | undefined;
  try {
    before = decodeHomeSchemaResult(await options.commands.check(), info);
  } catch (error) {
    if (error instanceof HomeSchemaCommandError) initialFailure = error;
  }
  const receipt: HomeMigrationReceipt = {
    ...identity,
    targetVersion: info.target_version,
    expectedIndexes: [...info.required_indexes],
    state: "refused",
    before,
    after: before,
    at: new Date().toISOString(),
  };
  const finish = async (successful: boolean) => {
    await options.record(structuredClone(receipt));
    return { receipt, proof: proof(identity, info, receipt.after, successful) };
  };
  if (initialFailure?.reason === "cleanup-failed") {
    receipt.state = "unknown";
    receipt.reason = initialFailure.reason;
    receipt.containerId = initialFailure.containerId;
    return finish(false);
  }
  const prior = options.prior;
  const unsettled =
    prior !== undefined &&
    (["intent", "unknown"].includes(prior.state) ||
      (prior.state === "failed" && !confirmedHomeMigrationResult(prior)));
  if (unsettled) {
    receipt.priorIntentId = prior.intentId;
    if (
      prior.imageDigest !== identity.imageDigest ||
      prior.imageConfigDigest !== identity.imageConfigDigest ||
      prior.sourceInputHash !== identity.sourceInputHash ||
      prior.targetVersion !== info.target_version ||
      prior.expectedIndexes.length !== info.required_indexes.length ||
      prior.expectedIndexes.some((name) => !info.required_indexes.includes(name))
    ) {
      receipt.reason = "prior-image-intent-unsettled";
      return finish(false);
    }
  }
  if (before && ready(before, info)) {
    receipt.state = "skipped";
    return finish(true);
  }
  if (unsettled) {
    receipt.reason = "prior-intent-unsettled";
    return finish(false);
  }
  if (
    !before ||
    before.status !== "pending" ||
    before.applied_version === null ||
    before.applied_version > info.target_version
  ) {
    receipt.reason = before?.reason ?? "native-readiness-unreadable";
    return finish(false);
  }
  if (!options.admit(identity, info, before)) {
    receipt.reason = "unreviewed-transition";
    return finish(false);
  }
  if (options.retryIntentId !== undefined && !validHomeRetryIntent(options.retryIntentId)) {
    receipt.reason = "retry-authorization-invalid";
    return finish(false);
  }
  const failure = options.lastFailure;
  if (failure) {
    receipt.priorIntentId = failure.intentId;
    if (
      !changedHomeMigrationConditions(identity, info, before, failure) &&
      (!failure.intentId || options.retryIntentId !== failure.intentId)
    ) {
      receipt.reason = "prior-failure-unchanged";
      return finish(false);
    }
  }
  receipt.state = "intent";
  receipt.intentId = randomUUID();
  await options.record(structuredClone(receipt));
  let applied: HomeSchemaResult | null = null;
  try {
    applied = decodeHomeSchemaResult(
      await options.commands.migrate(async (containerId) => {
        if (!/^[a-f0-9]{64}$/.test(containerId))
          throw new HomeSchemaCommandError("invalid-receipt");
        receipt.containerId = containerId;
        await options.record(structuredClone(receipt));
      }),
      info,
    );
    receipt.nativeResult = applied;
  } catch (error) {
    receipt.state = "unknown";
    receipt.reason = error instanceof HomeSchemaCommandError ? error.reason : "command-failed";
    if (error instanceof HomeSchemaCommandError && error.containerId)
      receipt.containerId = error.containerId;
  }
  // Even a failed reply may have committed the schema before an online-index failure.
  try {
    receipt.after = decodeHomeSchemaResult(await options.commands.check(), info);
  } catch (error) {
    receipt.after = null;
    if (error instanceof HomeSchemaCommandError && error.reason === "cleanup-failed") {
      receipt.state = "unknown";
      receipt.reason = error.reason;
      receipt.containerId = error.containerId;
    }
  }
  if (applied && ready(applied, info) && receipt.after && ready(receipt.after, info)) {
    receipt.state = applied.status === "noop" ? "noop" : "migrated";
    return finish(true);
  }
  if (receipt.state !== "unknown") {
    receipt.state = "failed";
    receipt.reason = applied?.reason ?? "native-migration-incomplete";
  }
  return finish(false);
}
