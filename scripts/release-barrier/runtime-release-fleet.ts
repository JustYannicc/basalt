import { Schema } from "effect";
import { FleetConfiguration } from "../../src/pool/runtime-fleet/configuration.ts";
import type { RuntimeReleaseClient } from "./runtime-release-client.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { runtimeApplicationPins } from "./runtime-release-state.ts";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import { waitReleaseObservation } from "./runtime-release-readiness.ts";

/** Every configuration is retained before sending; a lost reply reads that exact operation. */
export async function configureReleaseFleet(
  client: RuntimeReleaseClient,
  record: RuntimeReleaseRecord,
  operationId: string,
  save: (next: RuntimeReleaseRecord) => Promise<void>,
) {
  let configuration = record.configurations[operationId];
  const current = await client.fleet();
  const snapshot = await client.inspect();
  if (!configuration) {
    const legacy = snapshot.selection?.active.identity;
    const applications = (["blue", "green"] as const).map((color) => {
      const application = record.baseline.applications[color];
      if (!application)
        throw new BarrierRefusal(
          "runtime-release-fleet-application-missing",
          `PoolRuntime${color}`,
        );
      return {
        color,
        ...runtimeApplicationPins(application.attributes, application.image.inputHash),
      };
    });
    if (!legacy) throw new BarrierRefusal("runtime-release-fleet-active-missing", "PoolWorker");
    const previous = current.permission;
    configuration = Schema.decodeUnknownSync(FleetConfiguration)({
      format: "pool-runtime-fleet-v1",
      controllerCode: snapshot.controllerCode,
      controllerId: legacy.controllerId,
      legacy,
      revision: (previous?.configuration.revision ?? 0) + 1,
      previousDigest: previous?.digest ?? null,
      active:
        applications.find((app) => app.applicationId === legacy.applicationId)?.color ??
        previous?.configuration.active ??
        "blue",
      applications,
      maximum: previous?.configuration.maximum ?? 4,
      targetActive: previous?.configuration.targetActive ?? 25,
      idleMilliseconds: previous?.configuration.idleMilliseconds ?? 60_000,
    });
    await save({
      ...record,
      configurations: { ...record.configurations, [operationId]: configuration },
    });
  }
  const frozen = configuration;
  await waitReleaseObservation(
    () => client.fleet(),
    (value) =>
      frozen.applications.every((app) =>
        value.bindings.some(
          (binding) =>
            binding.color === app.color &&
            binding.applicationId === app.applicationId &&
            binding.imageInput === app.imageInput,
        ),
      ),
    "PoolWorker.runtime-bindings",
    330_000,
  );
  const retained = (await client.fleet(operationId)).permission;
  if (retained) {
    sameProvisioningValue(
      "runtime-release.fleet-retained-configuration",
      frozen,
      retained.configuration,
    );
    sameProvisioningValue(
      "runtime-release.fleet-retained-digest",
      digest(canonical(frozen)),
      retained.digest,
    );
    return retained;
  }
  const response = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({
        operationId: Schema.String,
        digest: Schema.String,
        configuration: FleetConfiguration,
        enabled: Schema.Boolean,
      }),
    }),
  )(
    await client.call({ action: "fleet-configure", operationId, configuration: frozen }, true),
  ).result;
  sameProvisioningValue("runtime-release.fleet-configuration", frozen, response.configuration);
  sameProvisioningValue("runtime-release.fleet-digest", digest(canonical(frozen)), response.digest);
  return response;
}
