import { Schema } from "effect";
import { homeSchemaResultCodec, nativeHomeReasonCodes } from "./home-schema-operation.ts";
import { sqlSchemaNamespaces } from "./sql-schema-contract.ts";

const candidate = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const imageDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));
const inputHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u));
const at = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u));
const intentId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
);
const version = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const marker = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,160}$/u));
const markers = Schema.Array(marker).check(
  Schema.isMaxLength(256),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
const indexes = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,127}$/u)),
).check(
  Schema.isMaxLength(128),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
const status = Schema.Literals(["ready", "pending", "incompatible", "unreadable"]);

export const homeMigrationReceiptCodec = Schema.Struct({
  candidate,
  imageDigest,
  imageConfigDigest: imageDigest,
  baselineImageDigest: imageDigest,
  sourceInputHash: inputHash,
  baselineInputHash: inputHash,
  targetVersion: version,
  expectedIndexes: indexes,
  state: Schema.Literals(["skipped", "intent", "migrated", "noop", "refused", "failed", "unknown"]),
  before: Schema.NullOr(homeSchemaResultCodec),
  after: Schema.NullOr(homeSchemaResultCodec),
  nativeResult: Schema.optional(homeSchemaResultCodec),
  intentId: Schema.optional(intentId),
  priorIntentId: Schema.optional(intentId),
  containerId: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  reason: Schema.optional(
    Schema.Literals([
      ...nativeHomeReasonCodes,
      "command-failed",
      "command-timeout",
      "invalid-receipt",
      "image-mismatch",
      "pull-failed",
      "cleanup-failed",
      "native-readiness-unreadable",
      "unreviewed-transition",
      "native-migration-incomplete",
      "prior-image-intent-unsettled",
      "prior-intent-unsettled",
      "prior-failure-unchanged",
      "retry-authorization-invalid",
    ]),
  ),
  at,
});

const observation = Schema.Struct({
  namespace: Schema.Literals(sqlSchemaNamespaces),
  database: Schema.Literals(["tools", "pool"]),
  journal: marker,
  expected: markers.check(Schema.isMinLength(1)),
  applied: Schema.NullOr(markers),
  pending: Schema.NullOr(markers),
  unexpected: Schema.NullOr(markers),
  status,
  observedAt: at,
  reason: Schema.optional(
    Schema.Literals([
      "connection",
      "journal-missing",
      "journal-type",
      "identity",
      "query",
      "invalid-marker",
    ]),
  ),
  sqlState: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z0-9]{5}$/u))),
});

/** Receipts retain observations and intent even when readiness refused the release. */
export const sqlSchemaReceiptCodec = Schema.Struct({
  formatVersion: Schema.Literal(1),
  candidate,
  homeImageDigest: imageDigest,
  scope: Schema.Literal("six-schema-namespaces"),
  observations: Schema.Array(observation).check(
    Schema.isMinLength(6),
    Schema.isMaxLength(6),
    Schema.makeFilter((values) => new Set(values.map((value) => value.namespace)).size === 6),
  ),
  home: Schema.optional(
    Schema.Struct({
      imageDigest,
      targetVersion: version,
      expectedIndexes: indexes,
      readyIndexes: Schema.NullOr(indexes),
      pendingIndexes: Schema.NullOr(indexes),
      status,
      observedAt: at,
    }),
  ),
  homeMigration: Schema.optional(homeMigrationReceiptCodec),
});
