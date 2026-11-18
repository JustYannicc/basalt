import type { StateService } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { encodedRecordHash, readForwardPacket } from "./forward-model.ts";
import { journalKey } from "./forward-journal.ts";
import { openRecovery, sealRecovery } from "./recovery-envelope.ts";
import {
  ReleaseSettlementManifest,
  releaseSettlementDigest,
  releaseSettlementKey,
  type ReleaseSettlementManifest as SettlementManifest,
} from "./release-settlement-contract.ts";

const hash = (value: unknown) => digest(canonical(value));
const Header = Schema.Struct({
  format: Schema.Literal("pool-release-settlement-archive-v1"),
  candidate: Schema.String,
  sourceCandidate: Schema.String,
  manifest: Schema.String,
  sealed: Schema.Unknown,
});
const Archive = Schema.Struct({
  manifest: ReleaseSettlementManifest,
  source: Schema.Struct({ image: Schema.Unknown, forward: Schema.Unknown }),
});
const ForwardHeader = Schema.Struct({
  candidate: Schema.String,
  manifest: Schema.String,
  complete: Schema.Boolean,
  sealed: Schema.Unknown,
});
const refused = () => new BarrierRefusal("release-settlement-archive-drift", "PoolWorker");

export function sealReleaseSettlement(
  manifest: SettlementManifest,
  source: { image: unknown; forward: unknown },
  key: string,
) {
  if (
    hash(source.image) !== manifest.imageHeadDigest ||
    hash(source.forward) !== manifest.forwardHeadDigest
  )
    throw refused();
  const fingerprint = releaseSettlementDigest(manifest);
  return {
    format: "pool-release-settlement-archive-v1" as const,
    candidate: manifest.candidate,
    sourceCandidate: manifest.sourceCandidate,
    manifest: fingerprint,
    sealed: sealRecovery({ manifest, source }, key, manifest.candidate, fingerprint),
  };
}

export function openReleaseSettlement(value: unknown, key: string, source: string, target: string) {
  const header = Schema.decodeUnknownSync(Header, { onExcessProperty: "error" })(value);
  if (header.candidate !== target || header.sourceCandidate !== source) throw refused();
  const saved = Schema.decodeUnknownSync(Archive, { onExcessProperty: "error" })(
    openRecovery(header.sealed, key, target, header.manifest),
  );
  const manifest = saved.manifest;
  if (
    manifest.candidate !== target ||
    manifest.sourceCandidate !== source ||
    releaseSettlementDigest(manifest) !== header.manifest ||
    hash(saved.source.image) !== manifest.imageHeadDigest ||
    hash(saved.source.forward) !== manifest.forwardHeadDigest ||
    manifest.proof.nativeBeforeDigest !== manifest.proof.nativeAfterDigest
  )
    throw refused();
  return { header, ...saved };
}

function sameReconciledForward(
  current: unknown,
  original: unknown,
  manifest: SettlementManifest,
  key: string,
) {
  const head = Schema.decodeUnknownSync(ForwardHeader)(current);
  const before = Schema.decodeUnknownSync(ForwardHeader)(original);
  if (!head.complete || head.candidate !== before.candidate || head.manifest !== before.manifest)
    return false;
  const oldPacket = readForwardPacket(
    openRecovery(before.sealed, key, before.candidate, before.manifest),
  );
  const nextPacket = readForwardPacket(
    openRecovery(head.sealed, key, head.candidate, head.manifest),
  );
  const { adoption: _oldAdoption, ...oldProof } = oldPacket;
  const { adoption, ...nextProof } = nextPacket;
  return (
    canonical(oldProof) === canonical(nextProof) &&
    adoption?.before === manifest.proof.nativeBeforeDigest &&
    adoption.after === manifest.proof.nativeAfterDigest
  );
}

/**
 * A target-bound archive releases the old image record without relabeling either old record as a
 * completed release. Returns the authorizing manifest, or undefined when no archive exists.
 */
export const authorizedReleaseSettlement = (
  state: StateService,
  scope: { name: string; stage: string },
  key: string,
  source: string,
  target: string,
  currentImage: unknown,
) =>
  Effect.gen(function* () {
    const raw = yield* state.getOutput(releaseSettlementKey(scope, source, target));
    if (raw === undefined) return undefined;
    const saved = openReleaseSettlement(raw, key, source, target);
    if (
      saved.manifest.stack !== scope.name ||
      saved.manifest.stage !== scope.stage ||
      hash(currentImage) !== saved.manifest.imageHeadDigest
    )
      throw refused();
    const currentForward = yield* state.getOutput(journalKey(scope));
    if (
      hash(currentForward) !== saved.manifest.forwardHeadDigest &&
      !sameReconciledForward(currentForward, saved.source.forward, saved.manifest, key)
    )
      throw refused();
    for (const resource of saved.manifest.proof.nativeResources) {
      const row = yield* state.get({ stack: scope.name, stage: scope.stage, fqn: resource.fqn });
      if (encodedRecordHash(row) !== resource.digest) throw refused();
    }
    const { proof } = saved.manifest;
    if (
      proof.disposition === "abandoned-before-forward" &&
      hash((yield* state.getOutput({ stack: scope.name, stage: scope.stage })) ?? null) !==
        proof.stackOutputDigest
    )
      throw refused();
    return saved.manifest;
  });
