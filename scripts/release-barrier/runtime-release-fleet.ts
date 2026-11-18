import { Schema } from "effect";
import {
  FleetConfiguration,
  occupiesApplication,
  type FleetApplicationPins,
} from "../../src/pool/runtime-fleet/configuration.ts";
import { runtimeColors, type RuntimeColor } from "../../src/pool/image-release-plan.ts";
import type { RuntimeReleaseClient } from "./runtime-release-client.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { runtimeApplicationPins } from "./runtime-release-state.ts";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import { waitReleaseObservation } from "./runtime-release-readiness.ts";

/** The fleet colours whose applications the record's baseline holds, in fleet order. */
export const fleetColors = (record: Pick<RuntimeReleaseRecord, "baseline">) =>
  runtimeColors.filter((color) => record.baseline.applications[color] !== undefined);

/** The fleet applications a release declares: each colour's native application on its own pins. */
export function releaseFleetApplications(record: Pick<RuntimeReleaseRecord, "baseline">) {
  return runtimeColors.map((color) => {
    const application = record.baseline.applications[color];
    if (!application)
      throw new BarrierRefusal("runtime-release-fleet-application-missing", `PoolRuntime${color}`);
    return {
      color,
      ...runtimeApplicationPins(application.attributes, application.image.inputHash),
    };
  });
}

type Application = ReturnType<typeof releaseFleetApplications>[number];
/**
 * The colour a fleet configuration names active: the selected primary's, else the colour the
 * previous permission named, else blue.
 */
export const releaseFleetActive = (
  applications: readonly Pick<Application, "color" | "applicationId">[],
  selected: { applicationId: string } | undefined,
  previous: FleetConfiguration | undefined,
) =>
  applications.find((app) => app.applicationId === selected?.applicationId)?.color ??
  previous?.active ??
  "blue";

/**
 * The controller launches fleet runtimes only on the active colour's application, and an image
 * update needs the other colour unoccupied, so a fleet a release may move past runs every row on
 * the active application's full pins (configuration.ts occupiesApplication), never on the selected
 * root's image input.
 */
export const fleetRowsOnActive = (
  rows: readonly { target: FleetApplicationPins }[],
  applications: readonly (FleetApplicationPins & { color: string })[],
  active: string,
) => {
  const current = applications.filter((app) => app.color === active);
  return rows.every((row) => occupiesApplication(current, row.target));
};

/**
 * The colour a release's image update builds: an update already journaled names it; otherwise the
 * colour other than the selected primary's, which is green while the root, no fleet application,
 * is selected. The other colour is the one the release keeps serving.
 */
export const releaseInactiveColor = (
  update: { baseline: { color: RuntimeColor } } | undefined,
  applications: readonly Pick<Application, "color" | "applicationId">[],
  selectedApplicationId: string,
): RuntimeColor =>
  update?.baseline.color ??
  (applications.find((app) => app.applicationId === selectedApplicationId)?.color === "green"
    ? "blue"
    : "green");

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
    const applications = releaseFleetApplications(record);
    if (!legacy) throw new BarrierRefusal("runtime-release-fleet-active-missing", "PoolWorker");
    const previous = current.permission;
    const active = releaseFleetActive(applications, legacy, previous?.configuration);
    configuration = Schema.decodeUnknownSync(FleetConfiguration)({
      format: "pool-runtime-fleet-v1",
      controllerCode: snapshot.controllerCode,
      controllerId: legacy.controllerId,
      legacy,
      revision: (previous?.configuration.revision ?? 0) + 1,
      previousDigest: previous?.digest ?? null,
      active,
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
