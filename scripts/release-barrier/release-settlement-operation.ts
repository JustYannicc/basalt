import { State, type StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Schema } from "effect";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import type { ProvisioningWriter } from "./provisioning-operation.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import {
  releaseImageJournalKey,
  releaseSettlementKey,
  releaseSettlementDigest,
  ReleaseSettlementManifest,
  type ReleaseSettlementPlanRequest,
} from "./release-settlement-contract.ts";
import {
  collectReleaseSettlementProof,
  type ReleaseSettlementIo,
} from "./release-settlement-proof.ts";
import {
  authorizedReleaseSettlement,
  openReleaseSettlement,
  sealReleaseSettlement,
} from "./release-settlement-archive.ts";
import { journalKey } from "./forward-journal.ts";

const hash = (value: unknown) => digest(canonical(value));
type SettlementManifest = typeof ReleaseSettlementManifest.Type;
export type ReleaseSettlementIntent = {
  manifest: string;
  sourceCandidate: string;
  candidate: string;
  imageHeadDigest: string;
  forwardHeadDigest: string;
};
export type SettlementOperationIo = ReleaseSettlementIo & {
  directory: string;
  intent?(value: ReleaseSettlementIntent): Promise<void>;
};
export function assertReleaseSettlementPlanGo(
  request: typeof ReleaseSettlementPlanRequest.Type,
  now: number,
) {
  if (
    !request.coordinatorGo ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= now
  )
    throw new BarrierRefusal("release-settlement-plan-not-enabled", "PoolWorker");
}

export const assertReleaseSettlementArchiveAbsent = (
  state: Pick<StateService, "getOutput">,
  stack: Pick<CompiledStack, "name" | "stage">,
  source: string,
  target: string,
) =>
  Effect.gen(function* () {
    if ((yield* state.getOutput(releaseSettlementKey(stack, source, target))) !== undefined)
      throw new BarrierRefusal(
        "release-settlement-already-recorded-inspect-required",
        "PoolWorker",
      );
  });

export const planReleaseSettlement = (
  stack: CompiledStack,
  request: typeof ReleaseSettlementPlanRequest.Type,
  writer: ProvisioningWriter,
  key: string,
  io: SettlementOperationIo,
  now = Date.now,
) =>
  Effect.gen(function* () {
    assertReleaseSettlementPlanGo(request, now());
    if (
      stack.name !== "basalt" ||
      stack.stage !== "production" ||
      !writer.lease ||
      request.sourceCandidate === writer.candidate
    )
      throw new BarrierRefusal("release-settlement-scope-refused", "PoolWorker");
    const state = yield* yield* State;
    yield* assertReleaseSettlementArchiveAbsent(
      state,
      stack,
      request.sourceCandidate,
      writer.candidate,
    );
    const collected = yield* collectReleaseSettlementProof(
      stack,
      request.sourceCandidate,
      key,
      io.directory,
      io,
    );
    if (collected.proof.controller.target.accountId !== writer.accountId)
      throw new BarrierRefusal("release-settlement-account-refused", "PoolWorker");
    assertReleaseSettlementPlanGo(request, now());
    return Schema.decodeUnknownSync(ReleaseSettlementManifest)({
      format: "pool-release-settlement-v1",
      candidate: writer.candidate,
      sourceCandidate: request.sourceCandidate,
      stack: stack.name,
      stage: stack.stage,
      accountId: writer.accountId,
      operationId: request.operationId,
      imageHeadDigest: hash(collected.source.image),
      forwardHeadDigest: hash(collected.source.forward),
      proof: collected.proof,
    });
  });

function assertEnabled(manifest: SettlementManifest, enable: ProvisioningEnable, now: number) {
  if (
    !enable.coordinatorGo ||
    !enable.writerLease ||
    enable.manifest !== releaseSettlementDigest(manifest) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    enable.expiresAt <= now
  )
    throw new BarrierRefusal("release-settlement-not-enabled", "PoolWorker");
}

/** One authenticated output archives both heads and the full proof. Source journals and native resources remain untouched. */
export const applyReleaseSettlement = (
  stack: CompiledStack,
  manifest: SettlementManifest,
  key: string,
  enable: ProvisioningEnable,
  io: SettlementOperationIo,
  now = Date.now,
) =>
  Effect.gen(function* () {
    assertEnabled(manifest, enable, now());
    if (
      stack.name !== manifest.stack ||
      stack.stage !== manifest.stage ||
      manifest.candidate === manifest.sourceCandidate
    )
      throw new BarrierRefusal("release-settlement-scope-refused", "PoolWorker");
    if (!io.intent)
      throw new BarrierRefusal("release-settlement-intent-writer-unavailable", "PoolWorker");
    const state = yield* yield* State;
    const target = releaseSettlementKey(stack, manifest.sourceCandidate, manifest.candidate);
    if ((yield* state.getOutput(target)) !== undefined)
      throw new BarrierRefusal(
        "release-settlement-already-recorded-inspect-required",
        "PoolWorker",
      );
    const collected = yield* collectReleaseSettlementProof(
      stack,
      manifest.sourceCandidate,
      key,
      io.directory,
      io,
    );
    if (
      hash(collected.source.image) !== manifest.imageHeadDigest ||
      hash(collected.source.forward) !== manifest.forwardHeadDigest ||
      canonical(collected.proof) !== canonical(manifest.proof)
    )
      throw new BarrierRefusal("release-settlement-plan-drift", "PoolWorker");
    const archive = sealReleaseSettlement(manifest, collected.source, key);
    assertEnabled(manifest, enable, now());
    yield* Effect.promise(() =>
      io.intent!({
        manifest: releaseSettlementDigest(manifest),
        sourceCandidate: manifest.sourceCandidate,
        candidate: manifest.candidate,
        imageHeadDigest: manifest.imageHeadDigest,
        forwardHeadDigest: manifest.forwardHeadDigest,
      }),
    );
    assertEnabled(manifest, enable, now());
    if ((yield* state.getOutput(target)) !== undefined)
      throw new BarrierRefusal(
        "release-settlement-already-recorded-inspect-required",
        "PoolWorker",
      );
    yield* state
      .setOutput({ ...target, value: archive })
      .pipe(
        Effect.catchCause(() =>
          Effect.fail(
            new BarrierRefusal(
              "release-settlement-write-unconfirmed-inspect-required",
              "PoolWorker",
            ),
          ),
        ),
      );
    const readback = yield* state.getOutput(target);
    if (hash(readback) !== hash(archive))
      throw new BarrierRefusal(
        "release-settlement-write-unconfirmed-inspect-required",
        "PoolWorker",
      );
    openReleaseSettlement(readback, key, manifest.sourceCandidate, manifest.candidate);
    if (
      hash(yield* state.getOutput(releaseImageJournalKey(stack))) !== manifest.imageHeadDigest ||
      hash(yield* state.getOutput(journalKey(stack))) !== manifest.forwardHeadDigest
    )
      throw new BarrierRefusal("release-settlement-source-head-changed", "PoolWorker");
    if (
      !(yield* authorizedReleaseSettlement(
        state,
        stack,
        key,
        manifest.sourceCandidate,
        manifest.candidate,
        collected.source.image,
      ))
    )
      throw new BarrierRefusal(
        "release-settlement-write-unconfirmed-inspect-required",
        "PoolWorker",
      );
    return {
      format: "pool-release-settlement-receipt-v1" as const,
      manifest: releaseSettlementDigest(manifest),
      archiveDigest: hash(readback),
      sourceRecordsUnchanged: true,
      nativeBeforeDigest: manifest.proof.nativeBeforeDigest,
      nativeAfterDigest: manifest.proof.nativeAfterDigest,
      stateWrites: 1,
      runtimeMutations: 0,
    };
  });

export const inspectReleaseSettlement = (
  stack: Pick<CompiledStack, "name" | "stage">,
  manifest: SettlementManifest,
  key: string,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const value = yield* state.getOutput(
      releaseSettlementKey(stack, manifest.sourceCandidate, manifest.candidate),
    );
    if (value === undefined)
      return { format: "pool-release-settlement-inspection-v1", disposition: "absent" };
    const saved = openReleaseSettlement(value, key, manifest.sourceCandidate, manifest.candidate);
    if (releaseSettlementDigest(saved.manifest) !== releaseSettlementDigest(manifest))
      throw new BarrierRefusal("release-settlement-inspection-mismatch", "PoolWorker");
    return {
      format: "pool-release-settlement-inspection-v1",
      disposition: "archived",
      manifest: releaseSettlementDigest(manifest),
      archiveDigest: hash(value),
      sourceImageUnchanged:
        hash(yield* state.getOutput(releaseImageJournalKey(stack))) === manifest.imageHeadDigest,
      sourceForwardUnchanged:
        hash(yield* state.getOutput(journalKey(stack))) === manifest.forwardHeadDigest,
    };
  });
