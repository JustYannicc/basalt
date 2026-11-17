import { Schema } from "effect";
import { BaselineController } from "./baseline-controller.ts";
import { canonical, digest } from "./manifest.ts";

export const SettlementHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const versions = Schema.Array(
  Schema.Struct({ versionId: Schema.NonEmptyString, percentage: Schema.Number }),
);
export const ReleaseSettlementPlanRequest = Schema.Struct({
  kind: Schema.Literal("release-settlement"),
  sourceCandidate: commit,
  operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u)),
  coordinatorGo: Schema.NonEmptyString,
  expiresAt: Schema.Int,
});
export const ReleaseSettlementProof = Schema.Struct({
  disposition: Schema.Literal("abandoned-before-controller"),
  controller: BaselineController,
  health: Schema.Struct({ instanceId: Schema.NonEmptyString, bootId: Schema.NonEmptyString }),
  imageBaselineDigest: SettlementHash,
  nativeBeforeDigest: SettlementHash,
  nativeAfterDigest: SettlementHash,
  nativeResources: Schema.Array(
    Schema.Struct({ fqn: Schema.NonEmptyString, digest: SettlementHash }),
  ),
  workers: Schema.Array(
    Schema.Struct({
      worker: Schema.NonEmptyString,
      target: SettlementHash,
      baseline: versions,
      active: versions,
      accepted: Schema.NullOr(Schema.NonEmptyString),
      placements: Schema.Array(
        Schema.Struct({ versionId: Schema.NonEmptyString, digest: SettlementHash }),
      ),
    }),
  ),
  applications: Schema.Array(
    Schema.Struct({ resource: Schema.NonEmptyString, digest: SettlementHash }),
  ),
  forwardManifest: SettlementHash,
  forwardProofDigest: SettlementHash,
  stateWrites: Schema.Literal(0),
  runtimeMutations: Schema.Literal(0),
});
export const ReleaseSettlementManifest = Schema.Struct({
  format: Schema.Literal("pool-release-settlement-v1"),
  candidate: commit,
  sourceCandidate: commit,
  stack: Schema.Literal("basalt"),
  stage: Schema.Literal("production"),
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  operationId: Schema.NonEmptyString,
  imageHeadDigest: SettlementHash,
  forwardHeadDigest: SettlementHash,
  proof: ReleaseSettlementProof,
});
export type ReleaseSettlementManifest = typeof ReleaseSettlementManifest.Type;
export const releaseSettlementDigest = (value: ReleaseSettlementManifest) =>
  digest(
    canonical(
      Schema.decodeUnknownSync(ReleaseSettlementManifest, { onExcessProperty: "error" })(value),
    ),
  );
export const releaseImageJournalKey = (scope: { name: string; stage: string }) => ({
  stack: `${scope.name}-runtime-image-release`,
  stage: scope.stage,
});
export const releaseSettlementKey = (
  scope: { name: string; stage: string },
  source: string,
  target: string,
) => ({
  // State's HTTP router limits each path parameter to 100 characters.
  stack: `${scope.name}-release-settlement-${digest(canonical({ source, target }))}`,
  stage: scope.stage,
});
