import { Effect, Schema } from "effect";
import {
  AdmissionProof,
  decodeAdmissionProof,
  type UnattestedActive,
} from "../../src/pool/runtime-slots/admission-proof.ts";
import {
  AdoptionReadbackMismatch,
  decodeUnattestedAdoptionResponse,
} from "../../src/pool/runtime-slots/adoption-readback.ts";
import {
  ControllerCode,
  PromotionReceipt,
  RetirementReceipt,
  SlotIdentity,
  SlotSelection,
} from "../../src/pool/runtime-slots/contract.ts";
import {
  decodeRuntimeHandoffCommand,
  type RuntimeHandoffCommand,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import { firstHandoffRuntimeEnable, type FirstHandoffManifest } from "./first-handoff-contract.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";
import { observeFirstHandoffLegacy, observeFirstHandoffSelected } from "./first-handoff-observe.ts";
import { signRuntimeAdmission } from "./runtime-slot-proof.ts";
import { authorizeRuntimeStart, attestRuntimeRelease } from "./runtime-slot-admission.ts";
import { runtimeHandoffRequest } from "./runtime-slot-rpc.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

export const decodeHandoffGrant = decodeProvisioningInput(
  Schema.Struct({
    proof: AdmissionProof,
    envelope: Schema.NonEmptyString,
    digest: Schema.String,
  }),
  "firstHandoff.authorization",
);
export type HandoffGrant = ReturnType<typeof decodeHandoffGrant>;
type Action<T> = T extends unknown ? Omit<T, "controllerCode" | "at" | "expiresAt"> : never;
const identityResponse = decodeProvisioningInput(
  Schema.Struct({ result: SlotIdentity }),
  "firstHandoff.start",
);
const promotionResponse = decodeProvisioningInput(
  Schema.Struct({ result: PromotionReceipt }),
  "firstHandoff.promotion",
);
const drainResponse = decodeProvisioningInput(
  Schema.Struct({ result: RetirementReceipt }),
  "firstHandoff.drain",
);
const inspected = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      controllerCode: ControllerCode,
      selection: SlotSelection,
      digest: Schema.String,
    }),
  }),
);

export function readFirstHandoffAdoption(value: unknown, original: UnattestedActive) {
  try {
    return decodeUnattestedAdoptionResponse(value, original);
  } catch (error) {
    if (error instanceof AdoptionReadbackMismatch)
      throw provisioningRefusal(
        "first-handoff-adoption-mismatch",
        `firstHandoff.adoption.${error.property}`,
        error.expected,
        error.observed,
      );
    throw provisioningRefusal(
      "first-handoff-adoption-unverified",
      "firstHandoff.adoption.response",
      "exact-acknowledged-legacy-operation",
      "invalid-response",
    );
  }
}

export interface FirstHandoffRuntime {
  candidateApplication(): Promise<void>;
  legacyBaseline(): Promise<void>;
  legacyCode(): Promise<void>;
  authorizeLegacy(): Promise<HandoffGrant>;
  adopt(grant: HandoffGrant): Promise<unknown>;
  readback(grant: HandoffGrant): Promise<unknown>;
  authorizeStart(): Promise<HandoffGrant>;
  start(grant: HandoffGrant): Promise<SlotIdentity>;
  join(): Promise<HandoffGrant>;
  promote(grant: HandoffGrant, identity: SlotIdentity): Promise<PromotionReceipt>;
  drain(): Promise<RetirementReceipt>;
  selected(identity: SlotIdentity): Promise<void>;
}

export const firstHandoffRuntime = (input: {
  manifest: FirstHandoffManifest;
  enable: ProvisioningEnable;
  signingKey: string;
  target: PoolOperationsTarget;
  fetcher?: Fetcher;
  now?: () => number;
}) =>
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof readRuntimeProviderProof>>>();
    const run = Effect.runPromiseWith(context);
    const { manifest, signingKey, target } = input;
    const now = input.now ?? Date.now;
    const enabled = (role: "legacy" | "candidate") =>
      firstHandoffRuntimeEnable(manifest, role, input.enable, now());
    const call = (role: "legacy" | "candidate", command: Action<RuntimeHandoffCommand>) => {
      const at = now();
      return runtimeHandoffRequest(
        manifest[role],
        enabled(role),
        signingKey,
        decodeRuntimeHandoffCommand(
          {
            ...command,
            controllerCode: manifest[role].controllerCode,
            at,
            expiresAt: Math.min(at + 60_000, input.enable.expiresAt),
          },
          at,
        ),
        target,
        now,
      );
    };
    const legacyProof = (grant: HandoffGrant) => {
      if (grant.proof.kind !== "unattested-active")
        throw provisioningRefusal(
          "first-handoff-proof-kind",
          "firstHandoff.legacy.proof",
          "unattested-active",
          grant.proof.kind,
        );
      return grant.proof;
    };
    const candidateInput = () => ({
      manifest: manifest.candidate,
      enable: enabled("candidate"),
      signingKey,
      target,
      fetcher: input.fetcher,
      now,
    });
    const service: FirstHandoffRuntime = {
      candidateApplication: async () => {
        enabled("candidate");
        await run(readRuntimeProviderProof(manifest.candidate, "application", input.fetcher, now));
      },
      legacyBaseline: () => {
        enabled("legacy");
        return run(observeFirstHandoffLegacy(input, "baseline"));
      },
      legacyCode: () => {
        enabled("legacy");
        return run(observeFirstHandoffLegacy(input, "code"));
      },
      authorizeLegacy: async () => {
        const provider = await run(
          readRuntimeProviderProof(manifest.legacy, "runtime", input.fetcher, now),
        );
        return signRuntimeAdmission(
          manifest.legacy,
          "unattested-active",
          {
            provider,
            selection: manifest.legacy.selection,
            unattestedBootId: manifest.legacyBootId,
          },
          enabled("legacy"),
          signingKey,
          now,
        );
      },
      adopt: async (grant) => {
        const original = legacyProof(grant);
        decodeAdmissionProof(original, now());
        return readFirstHandoffAdoption(
          await call("legacy", { action: "adopt", proof: grant.envelope }),
          original,
        );
      },
      readback: async (grant) =>
        readFirstHandoffAdoption(
          await call("legacy", { action: "witness", target: manifest.legacy.target }),
          legacyProof(grant),
        ),
      authorizeStart: () => run(authorizeRuntimeStart(candidateInput())),
      start: async (grant) => {
        sameProvisioningValue("firstHandoff.start.kind", "start", grant.proof.kind);
        decodeAdmissionProof(grant.proof, now());
        const result = identityResponse(
          await call("candidate", { action: "stage", proof: grant.envelope }),
        ).result;
        sameProvisioningValue("firstHandoff.started.target", manifest.candidate.target, {
          ...result,
          bootId: undefined,
        });
        return result;
      },
      join: () => run(attestRuntimeRelease(candidateInput())),
      promote: async (grant, identity) => {
        sameProvisioningValue("firstHandoff.join.kind", "attested", grant.proof.kind);
        sameProvisioningValue(
          "firstHandoff.join.boot",
          identity.bootId,
          "bootId" in grant.proof ? grant.proof.bootId : null,
        );
        decodeAdmissionProof(grant.proof, now());
        const intent = {
          operationId: manifest.promotionOperationId,
          controllerCode: manifest.candidate.controllerCode,
          expectedEpoch: manifest.candidate.selection.expectedEpoch,
          previous: { ...manifest.legacy.target, bootId: manifest.legacyBootId },
          candidate: identity,
          policyDigest: manifest.candidate.selection.policyDigest,
        };
        const result = promotionResponse(
          await call("candidate", { action: "promote", intent, proof: grant.envelope }),
        ).result;
        sameProvisioningValue("firstHandoff.promotion.intent", intent, result.intent);
        sameProvisioningValue("firstHandoff.promotion.status", "promoted", result.status);
        return result;
      },
      drain: async () => {
        const result = drainResponse(
          await call("candidate", { action: "drain", operationId: manifest.drainOperationId }),
        ).result;
        sameProvisioningValue(
          "firstHandoff.drain",
          {
            operationId: manifest.drainOperationId,
            target: manifest.legacy.target,
            identity: { ...manifest.legacy.target, bootId: manifest.legacyBootId },
            status: "retired",
          },
          { ...result, at: undefined },
        );
        return result;
      },
      selected: async (identity) => {
        const result = inspected(await call("candidate", { action: "inspect" })).result;
        sameProvisioningValue(
          "firstHandoff.selected.controllerCode",
          manifest.candidate.controllerCode,
          result.controllerCode,
        );
        sameProvisioningValue(
          "firstHandoff.selected.policy",
          manifest.candidate.selection.policyDigest,
          result.digest,
        );
        sameProvisioningValue(
          "firstHandoff.selected",
          {
            epoch: manifest.candidate.selection.expectedEpoch + 1,
            active: { target: manifest.candidate.target, identity, fenced: false },
          },
          result.selection,
        );
        await run(observeFirstHandoffSelected(input, identity));
      },
    };
    return service;
  });
