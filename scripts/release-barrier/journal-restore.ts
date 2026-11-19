import { State } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import { journalKey } from "./forward-journal.ts";
import { readRuntimeProvisioningHeader } from "./provisioning-header.ts";
import {
  assertB102CompletedHead,
  b102ReaderCommit,
  b102ReaderDigest,
} from "./b102-journal-reader.ts";
import { observationStoreDigest, observationStoreSdkDigest } from "./observation-store-contract.ts";
import {
  observationStoreDeclaration,
  assertObservationStorePlanGo,
} from "./observation-store-plan.ts";
import { verifyObservationStore } from "./observation-store-apply.ts";
import {
  JournalRestoreManifest,
  journalRestoreDigest,
  type AdoptionProof,
  type JournalRestorePlanRequest,
} from "./journal-restore-contract.ts";
import { sameProvisioningValue, provisioningRefusal } from "./provisioning-refusal.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import type { ProvisioningWriter } from "./provisioning-operation.ts";

const hash = (value: unknown) => digest(canonical(value));
const archiveKey = (head: string) => ({
  stack: `basalt-provisioning-archive-${head}`,
  stage: "production",
});
const same = sameProvisioningValue;

export function checkedRestoreHead(value: unknown, proof: AdoptionProof, key: string) {
  const saved = readRuntimeProvisioningHeader(value, key);
  if (!saved) throw new Error("Restore requires an authenticated provisioning head");
  const manifest = observationStoreDigest(proof.adoption);
  same(
    "restore.current.record",
    {
      schemaVersion: 2,
      candidate: proof.adoption.candidate,
      manifest,
      resource: "PoolObservationSecrets",
      complete: true,
      receipt: hash(proof.receipt),
      operations: {
        "store-adopt": { request: manifest, outcome: "acknowledged", result: proof.receipt },
      },
    },
    saved.record,
  );
  assertB102CompletedHead(saved.header.previous, key);
  return { head: saved.header, previous: saved.header.previous };
}

const verifyNative = (stack: CompiledStack, proof: AdoptionProof) =>
  Effect.gen(function* () {
    same("restore.sdk", proof.adoption.sdkSourceDigest, observationStoreSdkDigest());
    same(
      "restore.declaration",
      proof.adoption.declarationDigest,
      observationStoreDeclaration(stack),
    );
    const receipt = yield* verifyObservationStore(stack, proof.adoption);
    same("restore.native.receipt", proof.receipt, receipt);
    return receipt.nativeAfterDigest;
  });

export const planJournalRestore = (
  stack: CompiledStack,
  request: typeof JournalRestorePlanRequest.Type,
  writer: ProvisioningWriter,
  proof: AdoptionProof,
  key: string,
  now: () => number = Date.now,
) =>
  Effect.gen(function* () {
    assertObservationStorePlanGo(request, now());
    if (!writer.lease) throw new Error("Restore requires the exclusive production writer");
    same("restore.account", writer.accountId, proof.adoption.accountId);
    same("restore.source", request.source, proof.source);
    same("restore.adoption", request.adoption, proof.adoption);
    const state = yield* yield* State;
    const raw = yield* state.getOutput(journalKey(stack));
    const checked = checkedRestoreHead(raw, proof, key);
    const currentHeadDigest = hash(raw);
    const previousHeadDigest = hash(checked.previous);
    same(
      "restore.archive.before",
      undefined,
      yield* state.getOutput(archiveKey(currentHeadDigest)),
    );
    const nativeStoreDigest = yield* verifyNative(stack, proof);
    same(
      "restore.current.afterPlan",
      currentHeadDigest,
      hash(yield* state.getOutput(journalKey(stack))),
    );
    return Schema.decodeUnknownSync(JournalRestoreManifest, { onExcessProperty: "error" })({
      format: "pool-observation-journal-restore-v1",
      candidate: writer.candidate,
      stack: "basalt",
      stage: "production",
      accountId: writer.accountId,
      operationId: request.operationId,
      source: request.source,
      adoption: request.adoption,
      currentHeadDigest,
      previousHeadDigest,
      nativeStoreDigest,
      decoderDigest: b102ReaderDigest(),
    });
  });

function assertEnabled(manifest: JournalRestoreManifest, enable: ProvisioningEnable, now: number) {
  if (
    !enable.coordinatorGo ||
    !enable.writerLease ||
    enable.manifest !== journalRestoreDigest(manifest) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    enable.expiresAt <= now
  )
    throw provisioningRefusal(
      "journal-restore-not-enabled",
      "restore.go",
      "reviewed-unexpired-GO",
      "unavailable",
    );
}

/** A durable archive is the send intent. Any existing intent requires inspection, never a second restore. */
export const applyJournalRestore = (
  stack: CompiledStack,
  manifest: JournalRestoreManifest,
  proof: AdoptionProof,
  key: string,
  enable: ProvisioningEnable,
  now: () => number = Date.now,
) =>
  Effect.gen(function* () {
    assertEnabled(manifest, enable, now());
    same("restore.decoder", manifest.decoderDigest, b102ReaderDigest());
    same("restore.account", manifest.accountId, proof.adoption.accountId);
    same("restore.source", manifest.source, proof.source);
    same("restore.adoption", manifest.adoption, proof.adoption);
    const state = yield* yield* State;
    const target = journalKey(stack);
    const raw = yield* state.getOutput(target);
    const checked = checkedRestoreHead(raw, proof, key);
    same("restore.current", manifest.currentHeadDigest, hash(raw));
    same("restore.previous", manifest.previousHeadDigest, hash(checked.previous));
    const native = yield* verifyNative(stack, proof);
    same("restore.native", manifest.nativeStoreDigest, native);
    const archive = archiveKey(manifest.currentHeadDigest);
    same("restore.archive.before", undefined, yield* state.getOutput(archive));
    const pending = {
      format: "pool-observation-journal-archive-v1",
      operation: journalRestoreDigest(manifest),
      status: "prepared",
      head: raw,
      previousHeadDigest: manifest.previousHeadDigest,
      nativeStoreDigest: native,
    };
    assertEnabled(manifest, enable, now());
    yield* state.setOutput({ ...archive, value: pending });
    same("restore.archive.intent", pending, yield* state.getOutput(archive));
    same(
      "restore.current.beforeWrite",
      manifest.currentHeadDigest,
      hash(yield* state.getOutput(target)),
    );
    assertEnabled(manifest, enable, now());
    yield* state.setOutput({ ...target, value: checked.previous });
    const restored = yield* state.getOutput(target);
    same("restore.current.readback", manifest.previousHeadDigest, hash(restored));
    assertB102CompletedHead(restored, key);
    same("restore.native.after", native, yield* verifyNative(stack, proof));
    same("restore.archive.after", pending, yield* state.getOutput(archive));
    const receipt = {
      format: "pool-observation-journal-restore-receipt-v1",
      restoredHeadDigest: manifest.previousHeadDigest,
      archivedHeadDigest: manifest.currentHeadDigest,
      nativeStoreDigest: native,
      decoderCommit: b102ReaderCommit,
      decoderDigest: manifest.decoderDigest,
    };
    assertEnabled(manifest, enable, now());
    yield* state.setOutput({ ...archive, value: { ...pending, status: "complete", receipt } });
    same(
      "restore.archive.complete",
      { ...pending, status: "complete", receipt },
      yield* state.getOutput(archive),
    );
    return receipt;
  }).pipe(Effect.timeout("60 seconds"));

export const inspectJournalRestore = (
  stack: Pick<CompiledStack, "name" | "stage">,
  manifest: JournalRestoreManifest,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const raw = yield* state.getOutput(journalKey(stack));
    const archive = yield* state.getOutput(archiveKey(manifest.currentHeadDigest));
    const native = yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: "PoolObservationSecrets",
    });
    const status =
      archive === undefined
        ? "not-started"
        : Schema.decodeUnknownSync(
            Schema.Struct({ status: Schema.Literals(["prepared", "complete"]) }),
          )(archive).status;
    return {
      currentHeadDigest: raw === undefined ? null : hash(raw),
      expectedHeadDigest: manifest.currentHeadDigest,
      restoredHeadDigest: manifest.previousHeadDigest,
      status,
      nativeStoreDigest: native === undefined ? null : hash(encodeState(native)),
      archiveDigest: archive === undefined ? null : hash(archive),
    };
  });
