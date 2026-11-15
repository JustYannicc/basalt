import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { ProviderObservationTarget } from "../../src/pool/runtime-provider/observation.ts";
import { runtimeApplicationPins, type RuntimeReleaseState } from "./runtime-release-state.ts";
import type { RuntimeReleaseClient } from "./runtime-release-client.ts";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { sealRecovery } from "./recovery-envelope.ts";

/** The first bound controller GET gates runtime writes; exact provider identities stay encrypted. */
export async function verifyBoundProviderObservation(input: {
  state: RuntimeReleaseState;
  code: ControllerCode;
  client: Pick<RuntimeReleaseClient, "observeProvider">;
  directory: string;
  encryptionKey: string;
}) {
  const application = input.state.applications.root;
  const target = Schema.decodeUnknownSync(ProviderObservationTarget)(
    runtimeApplicationPins(application.attributes, application.image.inputHash),
  );
  const retain = async (
    status: "observed" | "refused",
    observation?: Awaited<ReturnType<RuntimeReleaseClient["observeProvider"]>>,
  ) => {
    const at = observation?.proof.observedAt ?? Date.now();
    const closed = {
      status,
      controllerCode: input.code,
      target,
      at,
      credentialBinding: "POOL_PROVIDER_OBSERVATION_TOKEN",
      ...(observation ? { observation } : {}),
    };
    const fingerprint = digest(canonical(closed));
    try {
      await mkdir(input.directory, { recursive: true });
      await writeFile(
        resolve(input.directory, "provider-observation.sealed.json"),
        JSON.stringify(
          sealRecovery(closed, input.encryptionKey, input.code.candidate, fingerprint),
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      await writeFile(
        resolve(input.directory, "provider-observation.json"),
        JSON.stringify(
          {
            status,
            candidate: input.code.candidate,
            workerInput: input.code.workerInput,
            at,
            credentialBinding: closed.credentialBinding,
            fingerprint,
            target: {
              account: digest(target.accountId),
              application: digest(target.applicationId),
              version: target.applicationVersion,
            },
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    } catch {
      throw new BarrierRefusal("runtime-provider-observation-retention-failed", "PoolWorker");
    }
  };
  let observation: Awaited<ReturnType<RuntimeReleaseClient["observeProvider"]>>;
  try {
    observation = await input.client.observeProvider(target);
    sameProvisioningValue(
      "runtime-provider-observation.target",
      target,
      Schema.decodeUnknownSync(ProviderObservationTarget)(observation.proof),
    );
    if (
      observation.proof.observedAt > Date.now() + 5_000 ||
      Date.now() - observation.proof.observedAt > 30_000
    )
      throw new BarrierRefusal("runtime-provider-observation-stale", "PoolWorker");
  } catch {
    await retain("refused");
    throw new BarrierRefusal("runtime-provider-observation-refused", "PoolWorker");
  }
  await retain("observed", observation);
  return observation;
}
