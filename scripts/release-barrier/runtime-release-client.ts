import { Effect, Schema } from "effect";
import {
  ControllerCode,
  SlotIdentity,
  SlotSelection,
  SlotTarget,
  PromotionReceipt,
} from "../../src/pool/runtime-slots/contract.ts";
import { SelectionProof } from "../../src/pool/runtime-slots/admission-proof.ts";
import { FleetConfiguration } from "../../src/pool/runtime-fleet/configuration.ts";
import { decodeRuntimeHandoffCommand } from "../../src/pool/runtime-slots/handoff-command.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { sendRuntimeCommand, type RuntimeCommandAction } from "./runtime-command-rpc.ts";
import {
  releasePromotionGate,
  retainReleaseStartup,
  type ReleasePromotionJournal,
} from "./runtime-release-promotion.ts";
import {
  freezeRuntimeHandoff,
  runtimeBridgeKeyDigest,
  runtimeHandoffDigest,
  type RuntimeHandoffManifest,
} from "./runtime-slot-manifest.ts";
import { authorizeRuntimeStart, attestRuntimeRelease } from "./runtime-slot-admission.ts";
import { signRuntimeAdmission } from "./runtime-slot-proof.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";
import { readFirstHandoffAdoption } from "./first-handoff-runtime.ts";
import { runtimeApplicationPins, type runtimeReleaseState } from "./runtime-release-state.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";
import { verifyContainerHealth } from "./container-health.ts";
import { BarrierRefusal } from "./refusal.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import {
  configurationDigest,
  type RuntimeConfiguration,
} from "../../src/pool/runtime-slots/configuration.ts";

const Policy = Schema.Struct({
  pool: Schema.String,
  organization: Schema.String,
  revision: Schema.Number,
  dirty: Schema.Boolean,
});
const Snapshot = Schema.Struct({
  controllerCode: ControllerCode,
  selection: Schema.optional(SlotSelection),
  policies: Schema.Array(Policy),
  denials: Schema.Array(Policy),
  digest: Schema.String,
});
const Permission = Schema.Struct({
  operationId: Schema.String,
  digest: Schema.String,
  configuration: FleetConfiguration,
  enabled: Schema.Boolean,
});
const Fleet = Schema.Struct({
  permission: Schema.optional(Permission),
  resources: Schema.Array(
    Schema.Struct({
      target: SlotTarget,
      phase: Schema.String,
      active: Schema.Number,
    }),
  ),
  bindings: Schema.Array(
    Schema.Struct({
      color: Schema.String,
      applicationId: Schema.String,
      imageInput: Schema.String,
    }),
  ),
});
const result = <T>(schema: Schema.Codec<T>, value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ result: schema }))(value).result;

/** One authenticated send per mutation. Recovery reads the controller's durable receipts. */
export const runtimeReleaseClient = (input: {
  state: Effect.Success<ReturnType<typeof runtimeReleaseState>>;
  code: typeof ControllerCode.Type;
  writer: RuntimeReleaseWriter;
  promotion: ReleasePromotionJournal;
  desiredConfiguration?: RuntimeConfiguration;
  target?: PoolOperationsTarget;
}) =>
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof authorizeRuntimeStart>>>();
    const run = Effect.runPromiseWith(context);
    const { state, code, writer } = input;
    const target = input.target ?? state.target;
    const signingKey = state.deploymentKey;
    const call = (action: RuntimeCommandAction, mutation = false) => {
      const send = () => {
        writer.assert();
        const at = Date.now();
        const command = decodeRuntimeHandoffCommand(
          { ...action, controllerCode: code, at, expiresAt: at + 60_000 },
          at,
        );
        return sendRuntimeCommand(command, signingKey, target, () => {
          writer.assert();
          decodeRuntimeHandoffCommand(command);
        });
      };
      return mutation ? writer.exclusive(send) : send();
    };
    const inspect = async () => {
      const value = result(Snapshot, await call({ action: "inspect" }));
      sameProvisioningValue("runtime-release.controller-code", code, value.controllerCode);
      return value;
    };
    const selection = (value: typeof Snapshot.Type) =>
      Schema.decodeUnknownSync(SelectionProof)({
        expectedEpoch: value.selection?.epoch ?? 0,
        active: value.selection?.active.identity ?? null,
        policyDigest: value.digest,
        revisions: [
          ...value.policies.map((row) => ({ ...row, retired: false })),
          ...value.denials.map((row) => ({ ...row, retired: true })),
        ].sort((left, right) => left.pool.localeCompare(right.pool)),
      });
    const manifest = async (
      target: SlotTarget,
      operationId: string,
      disposition: RuntimeHandoffManifest["disposition"] = "runtime-handoff",
    ) => {
      const application = Object.values(state.applications).find(
        (app) => app?.attributes.applicationId === target.applicationId,
      );
      if (!application)
        throw new BarrierRefusal("runtime-release-application-not-retained", target.applicationId);
      const pins = runtimeApplicationPins(application.attributes, target.imageInput);
      const keyDigest = runtimeBridgeKeyDigest(signingKey);
      return freezeRuntimeHandoff({
        disposition,
        candidate: writer.candidate,
        stack: "basalt",
        stage: "production",
        operationId,
        controllerCode: code,
        controller: { accountId: state.target.accountId, scriptName: state.target.worker },
        bridgeKey: { baselineDigest: keyDigest, candidateDigest: keyDigest },
        target,
        provider: {
          accountId: pins.accountId,
          namespaceId: pins.namespaceId,
          applicationConfigDigest: pins.applicationConfigDigest,
        },
        configuration: {
          ...(disposition === "preserve-unattested"
            ? state.configuration
            : (input.desiredConfiguration ?? state.configuration)),
          imageInput: target.imageInput,
        },
        selection: selection(await inspect()),
      });
    };
    const proofInput = (manifest: RuntimeHandoffManifest) => ({
      manifest,
      enable: writer.enable(runtimeHandoffDigest(manifest)),
      signingKey,
      target,
    });
    const health = async () => {
      const start = performance.now();
      const value = result(
        Schema.Struct({ identity: SlotIdentity, leaseMs: Schema.Number }),
        await call({ action: "active-health" }),
      );
      if (value.leaseMs <= performance.now() - start)
        throw new BarrierRefusal("runtime-release-health-expired", "PoolWorker");
      const snapshot = await inspect();
      sameProvisioningValue(
        "runtime-release.healthy-selection",
        snapshot.selection?.active.identity,
        value.identity,
      );
      return {
        instanceId: value.identity.instanceId,
        bootId: value.identity.bootId,
        checkedAt: Date.now(),
      };
    };
    return {
      call,
      inspect,
      manifest,
      health,
      fleet: async (operationId?: string) =>
        result(
          Fleet,
          await call({ action: "fleet-inspect", ...(operationId ? { operationId } : {}) }),
        ),
      async selectedCurrent(imageInput: string, configuration: RuntimeConfiguration) {
        const snapshot = await inspect();
        const identity = snapshot.selection?.active.identity;
        if (
          !identity ||
          identity.imageInput !== imageInput ||
          snapshot.selection!.active.fenced ||
          snapshot.selection!.active.retirement
        )
          return false;
        const witness = result(
          Schema.Struct({
            configurationFingerprint: Schema.optional(Schema.String),
            witness: Schema.optional(Schema.Struct({ configurationFingerprint: Schema.String })),
          }),
          await call({ action: "witness", target: snapshot.selection!.active.target }),
        );
        return (
          witness.witness?.configurationFingerprint === (await configurationDigest(configuration))
        );
      },
      async adopt() {
        const before = await inspect();
        if (before.selection) {
          await health();
          return;
        }
        const root = state.applications.root!;
        const observed = await verifyContainerHealth(
          target,
          root.image.inputHash,
          AbortSignal.timeout(15_000),
        );
        const retained = await manifest(
          {
            format: "pool-runtime-slot-v1",
            controllerId: observed.instanceId,
            instanceId: observed.instanceId,
            slotId: "legacy",
            applicationId: root.attributes.applicationId,
            applicationVersion: String(root.attributes.version),
            imageDigest: root.attributes.configuration.image.split("@")[1]!,
            imageInput: root.image.inputHash,
          },
          `adopt-${writer.candidate}`,
          "preserve-unattested",
        );
        const provider = await run(readRuntimeProviderProof(retained, "runtime"));
        const grant = await signRuntimeAdmission(
          retained,
          "unattested-active",
          { provider, selection: retained.selection, unattestedBootId: observed.bootId },
          writer.enable(runtimeHandoffDigest(retained)),
          signingKey,
        );
        if (grant.proof.kind !== "unattested-active")
          throw new BarrierRefusal("runtime-release-adoption-proof-kind");
        const ack = await call({ action: "adopt", proof: grant.envelope }, true);
        readFirstHandoffAdoption(ack, grant.proof);
        readFirstHandoffAdoption(
          await call({ action: "witness", target: retained.target }),
          grant.proof,
        );
        await health();
      },
      async promote(applicationId: string, operationId: string, pool: string) {
        const before = await inspect();
        if (before.selection?.active.target.applicationId === applicationId) {
          await health();
          return;
        }
        const chosen = result(
          SlotTarget,
          await call({ action: "candidate-target", applicationId, operationId }),
        );
        if (
          before.selection?.candidate &&
          JSON.stringify(before.selection.candidate.target) !== JSON.stringify(chosen)
        )
          throw new BarrierRefusal("runtime-release-other-candidate-pending", "PoolWorker");
        const retained = await manifest(chosen, operationId);
        const startup = await retainReleaseStartup({
          manifest: retained,
          pool,
          journal: input.promotion,
          call,
        });
        const options = proofInput(startup);
        let identity = before.selection?.candidate?.identity;
        if (!identity) {
          if (before.selection?.candidate)
            identity = result(SlotIdentity, await call({ action: "observe" }, true));
          else {
            const grant = await run(authorizeRuntimeStart(options));
            identity = result(
              SlotIdentity,
              await call({ action: "stage", proof: grant.envelope }, true),
            );
          }
        }
        const {
          gate,
          operationId: promotionOperationId,
          beforePromotion,
        } = await releasePromotionGate({
          operationId,
          candidate: identity,
          pool,
          selection: retained.selection,
          code,
          journal: input.promotion,
          call,
        });
        sameProvisioningValue("runtime-release.public-candidate", identity, gate.ticket.candidate);
        const joined = await run(
          attestRuntimeRelease({ ...options, selection: retained.selection }),
        );
        const intent = {
          operationId: promotionOperationId,
          controllerCode: code,
          expectedEpoch: retained.selection.expectedEpoch,
          previous: retained.selection.active!,
          candidate: identity,
          policyDigest: retained.selection.policyDigest,
        };
        await beforePromotion();
        const receipt = result(
          PromotionReceipt,
          await call({ action: "promote", intent, proof: joined.envelope }, true),
        );
        sameProvisioningValue("runtime-release.promotion-intent", intent, receipt.intent);
        sameProvisioningValue("runtime-release.promotion-status", "promoted", receipt.status);
        await health();
      },
    };
  });
export type RuntimeReleaseClient = Effect.Success<ReturnType<typeof runtimeReleaseClient>>;
