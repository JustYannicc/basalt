import type { CompiledStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Effect, Schema } from "effect";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import { canonical, digest } from "./manifest.ts";
import { ProvisioningActiveRead, readProvisioningActive } from "./provisioning-active.ts";
import {
  RuntimeProvisioningManifest,
  provisioningManifestDigest,
  type ProvisioningEnable,
} from "./provisioning-contract.ts";
import { ObservationTokenManifest, observationTokenDigest } from "./observation-token-contract.ts";
import {
  provisionDeclaredRuntime,
  provisionDeclaredObservationToken,
} from "./provisioning-declarations.ts";
import { stateProvisioningStore } from "./provisioning-state.ts";
import { decodeProvisioningRecord } from "./provisioning-journal.ts";
import { sourceRuntimeCreatePlan, sourceObservationTokenPlan } from "./provisioning-source-plan.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

export const ProvisioningOperation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("runtime"),
    manifest: RuntimeProvisioningManifest,
    activeRead: ProvisioningActiveRead,
  }),
  Schema.Struct({ kind: Schema.Literal("observation-token"), manifest: ObservationTokenManifest }),
]);
export type ProvisioningOperation = typeof ProvisioningOperation.Type;
const Go = Schema.Struct({
  coordinatorGo: Schema.NonEmptyString,
  manifest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  expiresAt: Schema.Int,
});
export const decodeProvisioningPacket = decodeProvisioningInput(
  Schema.Struct({ operation: ProvisioningOperation, go: Go }),
  "provisioning.packet",
);
export type ProvisioningPacket = ReturnType<typeof decodeProvisioningPacket>;
export const provisioningOperationDigest = (operation: ProvisioningOperation) =>
  digest(
    canonical(
      Schema.decodeUnknownSync(ProvisioningOperation, { onExcessProperty: "error" })(operation),
    ),
  );

export interface ProvisioningWriter {
  candidate: string;
  accountId: string;
  lease: string;
}
function validateIdentity(packet: ProvisioningPacket, writer: ProvisioningWriter) {
  const { operation, go } = packet;
  const manifest = operation.manifest;
  const fingerprint = provisioningOperationDigest(operation);
  sameProvisioningValue("provisioning.operation.candidate", writer.candidate, manifest.candidate);
  sameProvisioningValue(
    "provisioning.operation.scope",
    { stack: "basalt", stage: "production" },
    { stack: manifest.stack, stage: manifest.stage },
  );
  sameProvisioningValue(
    "provisioning.operation.account",
    writer.accountId,
    operation.kind === "runtime"
      ? operation.manifest.declaration.accountId
      : operation.manifest.accountId,
  );
  if (!writer.lease || !go.coordinatorGo || go.manifest !== fingerprint)
    throw provisioningRefusal(
      "provisioning-operation-not-enabled",
      "provisioning.operation.go",
      fingerprint,
      go.manifest,
    );
}
export function validateProvisioningOperation(
  packet: ProvisioningPacket,
  writer: ProvisioningWriter,
  now: number,
) {
  validateIdentity(packet, writer);
  const { operation, go } = packet;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(go.expiresAt) || go.expiresAt <= now)
    throw provisioningRefusal(
      "provisioning-operation-go-expired",
      "provisioning.operation.expiresAt",
      "future",
      "expired",
    );
  const enable: ProvisioningEnable = {
    ...go,
    writerLease: writer.lease,
    manifest:
      operation.kind === "runtime"
        ? provisioningManifestDigest(operation.manifest)
        : observationTokenDigest(operation.manifest),
  };
  return enable;
}

export const inspectDeclaredProvisioning = (
  stack: Pick<CompiledStack, "name" | "stage">,
  packet: ProvisioningPacket,
  writer: ProvisioningWriter,
  encryptionKey: string,
) =>
  Effect.gen(function* () {
    validateIdentity(packet, writer);
    sameProvisioningValue(
      "provisioning.operation.compiledScope",
      { name: "basalt", stage: "production" },
      { name: stack.name, stage: stack.stage },
    );
    const state = yield* yield* State;
    const operation = packet.operation;
    const manifest =
      operation.kind === "runtime"
        ? provisioningManifestDigest(operation.manifest)
        : observationTokenDigest(operation.manifest);
    const store = stateProvisioningStore(state, stack, encryptionKey, async () => {
      throw new Error("Inspection cannot write provisioning state");
    });
    const raw = yield* Effect.promise(() =>
      store.read({ candidate: operation.manifest.candidate, manifest }),
    );
    const journal = raw === undefined ? undefined : decodeProvisioningRecord(raw);
    const resource =
      operation.kind === "runtime"
        ? operation.manifest.declaration.fqn
        : "PoolProviderObservationToken";
    if (journal)
      sameProvisioningValue("provisioning.inspection.resource", resource, journal.resource);
    const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: resource });
    return {
      format: "pool-provisioning-inspection-v1",
      manifest: provisioningOperationDigest(operation),
      resource,
      complete: journal?.complete ?? false,
      operations: Object.entries(journal?.operations ?? {}).map(([step, value]) => ({
        step,
        outcome: value.outcome,
        request: value.request,
      })),
      native: {
        status: row?.status ?? "absent",
        digest: row === undefined ? null : digest(canonical(encodeState(row))),
      },
    };
  });

/** The main workflow's shared production lock covers this entire call, including native state and journal writes. */
export const runDeclaredProvisioning = (
  stack: CompiledStack,
  packet: ProvisioningPacket,
  writer: ProvisioningWriter,
  encryptionKey: string,
  signingKey: string,
  io: { now?: () => number; connect?: PoolOperationsTarget["connect"]; fetcher?: Fetcher } = {},
) =>
  Effect.gen(function* () {
    const now = io.now ?? Date.now;
    const enable = validateProvisioningOperation(packet, writer, now());
    sameProvisioningValue(
      "provisioning.operation.compiledScope",
      { name: "basalt", stage: "production" },
      { name: stack.name, stage: stack.stage },
    );
    if (!/^[a-f0-9]{64}$/iu.test(encryptionKey))
      throw provisioningRefusal(
        "provisioning-encryption-key-unavailable",
        "provisioning.encryptionKey",
        "32-byte-key",
        "unavailable",
      );
    if (packet.operation.kind === "runtime")
      yield* sourceRuntimeCreatePlan(stack, packet.operation.manifest, "$namespace-receipt");
    else yield* sourceObservationTokenPlan(stack, packet.operation.manifest);
    const state = yield* yield* State;
    let queue: Promise<unknown> = Promise.resolve();
    const store = stateProvisioningStore(
      state,
      stack,
      encryptionKey,
      <A>(work: () => Promise<A>) => {
        const pending = queue.then(() => {
          validateProvisioningOperation(packet, writer, now());
          return work();
        });
        queue = pending.catch(() => {});
        return pending;
      },
    );
    const operation = packet.operation;
    if (operation.kind === "observation-token")
      return yield* provisionDeclaredObservationToken(stack, {
        manifest: operation.manifest,
        enable,
        store,
        now,
      });
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof readProvisioningActive>>>();
    const run = Effect.runPromiseWith(context);
    return yield* provisionDeclaredRuntime(stack, {
      manifest: operation.manifest,
      enable,
      store,
      now,
      scriptName: operation.activeRead.controller.scriptName,
      active: () =>
        run(readProvisioningActive(operation.manifest, operation.activeRead, signingKey, io)),
    });
  });
