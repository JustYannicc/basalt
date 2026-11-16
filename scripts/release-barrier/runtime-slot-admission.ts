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

/** A stopped or missing runtime cannot become attested through provider image metadata alone. */
export const attestRuntimeRelease = (input: {
  manifest: RuntimeHandoffManifest;
  enable: ProvisioningEnable | undefined;
  signingKey: string;
  target: PoolOperationsTarget;
  fetcher?: Fetcher;
  now?: () => number;
  selection?: SelectionProof;
}) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;
    assertRuntimeProofEnable(input.manifest, input.enable, now());
    const witness = yield* Effect.tryPromise({
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

export const authorizeRuntimeStart = (input: Parameters<typeof attestRuntimeRelease>[0]) =>
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
