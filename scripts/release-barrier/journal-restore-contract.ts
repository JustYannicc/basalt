import { Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import { ObservationStoreManifest } from "./observation-store-contract.ts";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
export const AdoptionSource = Schema.Struct({
  runId: positive,
  attempt: positive,
  artifactId: positive,
  archiveDigest: hash,
  receiptDigest: hash,
});
export const StoreAdoptionReceipt = Schema.Struct({
  format: Schema.Literal("pool-observation-store-adoption-receipt-v1"),
  manifest: hash,
  nativeAfterDigest: hash,
  action: Schema.Literal("noop"),
  barrier: Schema.Literal("PASS"),
  barrierScope: Schema.Literal("PoolObservationSecrets"),
});
export const JournalRestorePlanRequest = Schema.Struct({
  kind: Schema.Literal("observation-store-restore"),
  operationId: Schema.NonEmptyString,
  coordinatorGo: Schema.NonEmptyString,
  expiresAt: Schema.Int,
  source: AdoptionSource,
  adoption: ObservationStoreManifest,
});
export const JournalRestoreManifest = Schema.Struct({
  format: Schema.Literal("pool-observation-journal-restore-v1"),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  stack: Schema.Literal("basalt"),
  stage: Schema.Literal("production"),
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  operationId: Schema.NonEmptyString,
  source: AdoptionSource,
  adoption: ObservationStoreManifest,
  currentHeadDigest: hash,
  previousHeadDigest: hash,
  nativeStoreDigest: hash,
  decoderDigest: hash,
});
export type JournalRestoreManifest = typeof JournalRestoreManifest.Type;
export const journalRestoreDigest = (value: JournalRestoreManifest) =>
  digest(
    canonical(
      Schema.decodeUnknownSync(JournalRestoreManifest, { onExcessProperty: "error" })(value),
    ),
  );
export type AdoptionProof = {
  source: typeof AdoptionSource.Type;
  adoption: typeof ObservationStoreManifest.Type;
  receipt: typeof StoreAdoptionReceipt.Type;
};
