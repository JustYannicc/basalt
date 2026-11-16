import { Schema } from "effect";
import {
  ControllerCode,
  SlotRefused,
  sameControllerCode,
  sameTarget,
  type SlotTarget,
} from "../runtime-slots/contract.ts";
import {
  ProviderApplicationProof,
  ProviderRuntimeProof,
  StartupWitness,
  decodeAdmissionProof,
  runtimeAttestationFormat,
} from "../runtime-slots/admission-proof.ts";
import { configurationDigest, type RuntimeConfiguration } from "../runtime-slots/configuration.ts";
import type { RuntimeHandoff } from "../runtime-slots/integration.ts";
import type { RuntimeProviderReader, RuntimeProviderTarget } from "../runtime-provider/read.ts";
import { providerDigest } from "../runtime-provider/canonical.ts";
import { signEnvelope } from "../token.ts";

interface Dependencies {
  handoff: RuntimeHandoff;
  configuration: RuntimeConfiguration;
  application: RuntimeProviderTarget;
  code: typeof ControllerCode.Type;
  provider: RuntimeProviderReader;
  key: string;
}

/** The deployed fleet permission authorizes bounded launches, using the existing signed start and attestation contracts. */
export class FleetAdmission {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async envelope(target: SlotTarget, kind: "initial-start" | "initial-attested") {
    const { application, configuration, handoff, code, provider, key } = this.deps;
    if (
      target.applicationId !== application.applicationId ||
      target.applicationVersion !== application.applicationVersion ||
      target.imageDigest !== application.imageDigest ||
      target.imageInput !== configuration.imageInput ||
      target.homePeerOrdinal !== configuration.homePeerOrdinal ||
      target.homePeerOrdinal === undefined
    )
      throw new SlotRefused("identity");
    const fingerprint = await configurationDigest(configuration);
    const operationId = `fleet-${target.slotId}`;
    const manifestDigest = await providerDigest({
      format: "pool-fleet-launch-v1",
      target,
      configurationFingerprint: fingerprint,
      application,
    });
    let witness: typeof StartupWitness.Type | undefined;
    if (kind === "initial-attested") {
      const observed = Schema.decodeUnknownSync(
        Schema.Struct({
          kind: Schema.Literal("witness"),
          controllerCode: ControllerCode,
          witness: StartupWitness,
        }),
      )(await handoff.witness(target));
      witness = observed.witness;
      if (
        !sameControllerCode(observed.controllerCode, code) ||
        witness.operationId !== operationId ||
        witness.manifestDigest !== manifestDigest ||
        witness.configurationFingerprint !== fingerprint ||
        !sameTarget(witness.target, target) ||
        !witness.bootId
      )
        throw new SlotRefused("identity");
    }
    const observation = await provider.observe(
      application,
      kind === "initial-attested" ? target.instanceId : undefined,
    );
    const snapshot = await handoff.storage.inspect();
    if (snapshot.selection) throw new SlotRefused("selection");
    const at = Date.now();
    const proof = decodeAdmissionProof({
      format: runtimeAttestationFormat,
      kind,
      operationId,
      manifestDigest,
      controllerCode: code,
      target,
      configurationFingerprint: fingerprint,
      selection: {
        expectedEpoch: 0,
        active: null,
        policyDigest: snapshot.digest,
        revisions: [
          ...snapshot.policies.map(({ pool, organization, revision }) => ({
            pool,
            organization,
            revision,
            retired: false,
          })),
          ...snapshot.denials.map(({ pool, organization, revision }) => ({
            pool,
            organization,
            revision,
            retired: true,
          })),
        ].sort((left, right) => left.pool.localeCompare(right.pool)),
      },
      provider:
        kind === "initial-start"
          ? Schema.decodeUnknownSync(ProviderApplicationProof)(observation)
          : Schema.decodeUnknownSync(ProviderRuntimeProof)(observation),
      at,
      expiresAt: at + 60_000,
      ...(witness ? { launch: witness.launch, bootId: witness.bootId } : {}),
    });
    return signEnvelope(key, runtimeAttestationFormat, proof);
  }
}
