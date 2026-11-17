import { Schema } from "effect";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { BaselineController } from "./baseline-controller.ts";
import { canonical, digest } from "./manifest.ts";

export const SettlementHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const versions = Schema.Array(
  Schema.Struct({ versionId: Schema.NonEmptyString, percentage: Schema.Number }),
);
export const ReleaseSettlementDisposition = Schema.Literals([
  "abandoned-before-controller",
  "controller-active-unadopted",
]);
export type ReleaseSettlementDisposition = typeof ReleaseSettlementDisposition.Type;
export const ReleaseSettlementPlanRequest = Schema.Struct({
  kind: Schema.Literal("release-settlement"),
  sourceCandidate: commit,
  operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u)),
  coordinatorGo: Schema.NonEmptyString,
  expiresAt: Schema.Int,
  // Absent keeps earlier reviewed requests, and their digests, as abandoned-before-controller.
  disposition: Schema.optional(ReleaseSettlementDisposition),
  // Required for controller-active-unadopted. Scale-out code phases defer the readiness command, so
  // native state still names the previous controller; the live controller confirms this code.
  sourceController: Schema.optional(ControllerCode),
});
const proofFields = {
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
};
export const ReleaseSettlementControllerReads = Schema.Struct({
  fleetDigest: SettlementHash,
  witness: Schema.Literal("absent"),
  finalInspect: Schema.Literal("no-selection"),
});
// Only an activated controller has adoption reads to prove; the earlier disposition never carries them.
export const ReleaseSettlementProof = Schema.Union([
  Schema.Struct({ disposition: Schema.Literal("abandoned-before-controller"), ...proofFields }),
  Schema.Struct({
    disposition: Schema.Literal("controller-active-unadopted"),
    controllerReads: ReleaseSettlementControllerReads,
    ...proofFields,
  }),
]);
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
