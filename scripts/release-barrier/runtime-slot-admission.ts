import { Effect } from "effect";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";
import { readRuntimeStartupWitness } from "./runtime-slot-rpc.ts";
import { assertRuntimeProofEnable, type RuntimeHandoffManifest } from "./runtime-slot-manifest.ts";
import { signRuntimeAdmission } from "./runtime-slot-proof.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import { BarrierRefusal } from "./manifest.ts";
import { provisioningRefusal } from "./provisioning-refusal.ts";
import type { SelectionProof } from "../../src/pool/runtime-slots/admission-proof.ts";

const refused = (reason: string, path: string) => (error: unknown) =>
  error instanceof BarrierRefusal
    ? error
    : provisioningRefusal(reason, path, "verified", "unverified");

interface AttestationInput {
  manifest: RuntimeHandoffManifest;
  enable: ProvisioningEnable | undefined;
  signingKey: string;
  target: PoolOperationsTarget;
  fetcher?: Fetcher;
  now?: () => number;
  selection?: SelectionProof;
}

/** The startup witness carries no clock, so it can be read before the send that carries the proof. */
export const witnessRuntimeRelease = (input: AttestationInput) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;
    assertRuntimeProofEnable(input.manifest, input.enable, now());
    return yield* Effect.tryPromise({
      try: () =>
        readRuntimeStartupWitness(
          input.manifest,
          input.enable,
          input.signingKey,
          input.target,
          now,
        ),
      catch: refused("runtime-startup-witness-unverified", "handoff.witness"),
    });
  });

/** The provider observation starts the attestation's freshness window, so sign just before sending. */
export const signRuntimeRelease = (
  input: AttestationInput,
  witness: Effect.Success<ReturnType<typeof witnessRuntimeRelease>>,
) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;
    assertRuntimeProofEnable(input.manifest, input.enable, now());
    const provider = yield* readRuntimeProviderProof(input.manifest, "runtime", input.fetcher, now);
    return yield* Effect.tryPromise({
      try: () =>
        signRuntimeAdmission(
          input.manifest,
          "attested",
          { provider, selection: input.selection ?? input.manifest.selection, witness },
          input.enable,
          input.signingKey,
          now,
        ),
      catch: refused("runtime-joined-admission-unverified", "handoff.proof"),
    });
  });

/** A stopped or missing runtime cannot become attested through provider image metadata alone. */
export const attestRuntimeRelease = (input: AttestationInput) =>
  Effect.flatMap(witnessRuntimeRelease(input), (witness) => signRuntimeRelease(input, witness));

export const authorizeRuntimeStart = (input: AttestationInput) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;
    assertRuntimeProofEnable(input.manifest, input.enable, now());
    const provider = yield* readRuntimeProviderProof(
      input.manifest,
      "application",
      input.fetcher,
      now,
    );
    return yield* Effect.tryPromise({
      try: () =>
        signRuntimeAdmission(
          input.manifest,
          "start",
          { provider, selection: input.manifest.selection },
          input.enable,
          input.signingKey,
          now,
        ),
      catch: refused("runtime-start-authorization-unverified", "handoff.start"),
    });
  });
