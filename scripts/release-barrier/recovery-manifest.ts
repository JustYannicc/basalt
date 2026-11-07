import { containerHealth } from "./container-health.ts";
import { Schema } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import { describeContainer } from "./container.ts";
import { attachmentCodec, configurationCodec, rolloutCodec } from "./container-schema.ts";

const baseline = Schema.Array(
  Schema.Struct({ versionId: Schema.String, percentage: Schema.Number }),
);
export const recoveryWorker = Schema.Struct({
  id: Schema.String,
  target: Schema.String,
  metadata: Schema.String,
  sourceMetadata: Schema.optional(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      bytes: Schema.Number,
      sha256: Schema.String,
    }),
  ),
  baseline,
});
const container = Schema.Struct({
  id: Schema.String,
  target: Schema.String,
  baseline: Schema.String,
  baselineVersion: Schema.Number,
  baselineDigest: Schema.String,
  configuration: Schema.String,
  rollout: Schema.String,
  inputHash: Schema.String,
  imageDigest: Schema.String,
  imageConfigDigest: Schema.String,
  platform: Schema.Literal("linux/amd64"),
  capabilityLabel: Schema.Literal("1"),
});
const description = {
  candidate: Schema.String,
  stack: Schema.String,
  stage: Schema.String,
  workers: Schema.Array(recoveryWorker),
};
const legacy = Schema.Struct(description);
const extended = Schema.Struct({
  ...description,
  schemaVersion: Schema.Literal(2),
  containers: Schema.Array(container),
});
export type RecoveryManifest = typeof legacy.Type | typeof extended.Type;
export function readRecoveryManifest(value: unknown): RecoveryManifest {
  const header = Schema.decodeUnknownSync(
    Schema.Struct({
      schemaVersion: Schema.optional(Schema.Number),
      containers: Schema.optional(Schema.Unknown),
    }),
  )(value);
  if (header.schemaVersion === 2)
    return Schema.decodeUnknownSync(extended, { onExcessProperty: "error" })(value);
  if (
    (header.schemaVersion !== undefined && header.schemaVersion !== 1) ||
    header.containers !== undefined
  )
    throw new BarrierRefusal("unsupported-recovery-manifest");
  return Schema.decodeUnknownSync(legacy)(value);
}
export type RecoveryWorker = typeof recoveryWorker.Type;
export const recoveryReceipt = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  candidate: Schema.String,
  manifest: Schema.String,
  accepted: Schema.Array(
    Schema.Struct({
      worker: Schema.String,
      versionId: Schema.String,
      startupTimeMs: Schema.Number,
    }),
  ),
  containers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        container: Schema.String,
        version: Schema.Number,
        rolloutId: Schema.optional(Schema.String),
        unchanged: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  pendingContainer: Schema.optional(
    Schema.Struct({
      container: Schema.String,
      phase: Schema.Literals(["rollout", "verification"]),
      version: Schema.optional(Schema.Number),
      rolloutId: Schema.optional(Schema.String),
    }),
  ),
});
export type RecoveryAdmission = typeof recoveryReceipt.Type;
export const readRecoveryProgress = Schema.decodeUnknownSync(
  Schema.Struct({
    candidate: Schema.String,
    manifest: Schema.String,
    restored: Schema.Array(Schema.String),
    pending: Schema.optional(Schema.String),
    failure: Schema.optional(Schema.String),
    containers: Schema.optional(
      Schema.Array(
        Schema.Struct({
          container: Schema.String,
          version: Schema.Number,
          rolloutId: Schema.optional(Schema.String),
          verified: Schema.optional(Schema.Boolean),
          health: Schema.optional(containerHealth),
        }),
      ),
    ),
    pendingContainer: Schema.optional(
      Schema.Struct({
        container: Schema.String,
        phase: Schema.Literals(["rollout", "verification"]),
        version: Schema.optional(Schema.Number),
        rolloutId: Schema.optional(Schema.String),
      }),
    ),
  }),
  { onExcessProperty: "error" },
);

const snapshot = Schema.Struct({
  applicationId: Schema.String,
  applicationName: Schema.String,
  accountId: Schema.String,
  version: Schema.Number,
  configuration: configurationCodec,
  schedulingPolicy: Schema.String,
  maxInstances: Schema.Number,
  constraints: Schema.optional(Schema.Unknown),
  affinities: Schema.optional(Schema.Unknown),
  durableObjects: Schema.optional(attachmentCodec),
});
const frozen = Schema.Struct({
  id: Schema.String,
  baseline: snapshot,
  configuration: configurationCodec,
  rolloutRequest: rolloutCodec,
  inputHash: Schema.String,
  imageDigest: Schema.String,
  imageConfigDigest: Schema.String,
  platform: Schema.Literal("linux/amd64"),
  capabilityLabel: Schema.Literal("1"),
});
export function readFrozenContainers(value: unknown) {
  const parsed = Schema.decodeUnknownSync(
    Schema.Struct({
      schemaVersion: Schema.Literal(2),
      candidate: Schema.String,
      stack: Schema.String,
      stage: Schema.String,
      containers: Schema.Array(frozen),
      workers: Schema.Unknown,
    }),
    { onExcessProperty: "error" },
  )(value);
  parsed.containers.forEach(describeContainer);
  return parsed;
}
