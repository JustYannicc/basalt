import { Schema } from "effect";
import { fleetClassName } from "../../../src/pool/fleet-deployment.ts";
import type { RuntimeColor } from "../../../src/pool/image-release-plan.ts";
import { FleetConfiguration } from "../../../src/pool/runtime-fleet/configuration.ts";
import type { ControllerCode, SlotIdentity } from "../../../src/pool/runtime-slots/contract.ts";
import type { ContainerAttributes } from "../container.ts";
import { canonical, digest } from "../manifest.ts";
import { decodeProvisioningManifest } from "../provisioning-contract.ts";
import type { RuntimeReleaseState } from "../runtime-release-state.ts";
import { provisioningFixture } from "./provisioning-fixtures.ts";
import { releaseFleetApplications } from "../runtime-release-fleet.ts";

/**
 * How far the source got past adopt: which colours it bootstrapped, which of those its bind phase
 * then linked, and whether it retained (and sent) its fleet configuration.
 */
export type BootstrapShape = {
  colors: readonly RuntimeColor[];
  bound?: readonly RuntimeColor[];
  configured?: boolean;
};

/** The idle application a bootstrap creates on the root's retained image: zero instances. */
export const bootstrappedApplication = (
  root: ContainerAttributes,
  color: RuntimeColor,
  imageInput: string,
) => ({
  ...root,
  hash: { ...root.hash!, image: imageInput },
  applicationId: `pool-${color}`,
  applicationName: `basalt-pool-${color}`,
  instances: 0,
  maxInstances: 4,
  durableObjects: { namespaceId: `namespace-${color}` },
});

/** The native instance a candidate's bootstrap declares for a colour, as bootstrapDeclaration does. */
export const bootstrapInstance = (candidate: string, color: RuntimeColor) =>
  digest(`${candidate}:${fleetClassName(color)}`).slice(0, 32);

/** The bootstrap manifest the source journaled beside the selected root, before it sent anything. */
export function bootstrapManifest(input: {
  color: RuntimeColor;
  source: string;
  accountId: string;
  rootApplicationId: string;
  epoch: number;
}) {
  const { manifest } = provisioningFixture(fleetClassName(input.color));
  return decodeProvisioningManifest({
    ...manifest,
    candidate: input.source,
    stack: "basalt",
    operationId: `bootstrap-${input.color}-${input.source}`,
    declaration: {
      ...manifest.declaration,
      accountId: input.accountId,
      instanceId: bootstrapInstance(input.source, input.color),
    },
    active: {
      ...manifest.active,
      applicationId: input.rootApplicationId,
      selectionEpoch: input.epoch,
    },
  });
}

/** The fleet configuration configureReleaseFleet retains once both colours are bound. */
export function fleetConfiguration(input: {
  code: ControllerCode;
  legacy: SlotIdentity;
  baseline: RuntimeReleaseState;
}) {
  return Schema.decodeUnknownSync(FleetConfiguration)({
    format: "pool-runtime-fleet-v1",
    controllerCode: input.code,
    controllerId: input.legacy.controllerId,
    legacy: input.legacy,
    revision: 1,
    previousDigest: null,
    active: "blue",
    applications: releaseFleetApplications(input),
    maximum: 4,
    targetActive: 25,
    idleMilliseconds: 60_000,
  });
}

/** What fleet-inspect answers: a binding per bound colour, and the permission once configured. */
export function bootstrappedFleet(
  shape: BootstrapShape,
  baseline: RuntimeReleaseState,
  configurations: Record<string, typeof FleetConfiguration.Type>,
) {
  const [operationId, configuration] = Object.entries(configurations)[0] ?? [];
  return {
    ...(configuration && operationId
      ? {
          permission: {
            operationId,
            digest: digest(canonical(configuration)),
            configuration,
            enabled: true,
          },
        }
      : {}),
    resources: [],
    bindings: (shape.bound ?? []).map((color) => ({
      color,
      applicationId: baseline.applications[color]!.attributes.applicationId,
      imageInput: baseline.applications[color]!.image.inputHash,
    })),
  };
}
