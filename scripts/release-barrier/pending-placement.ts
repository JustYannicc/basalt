import { Schema } from "effect";
import type * as Workers from "@distilled.cloud/cloudflare/workers";
import { BarrierRefusal, canonical } from "./manifest.ts";
import { assertScriptSettings } from "./script-settings.ts";
import { normalizePlacement, type ActiveWorkerPlacement } from "./script-placement.ts";

export const placementRepairTargets = [
  {
    role: "Api",
    scriptName: "basalt-api-production-tht46xu4nardtzl2",
    version: "f53d98f3-538d-4d49-ba2e-896b765de46d",
    deployment: "3d7c0322-862c-47ae-a6f3-4b1ebf3e3785",
    prior: "79d6d289-3adc-486d-a32a-fef84fa2011c",
  },
  {
    role: "AppPages",
    scriptName: "basalt-apppages-production-3syjgtzy4zbuqudq",
    version: "a03e66bd-1d48-4edb-8598-f6ef9fd7730f",
    deployment: "e743415a-04a6-4836-a5d5-9fb53295cdd0",
    prior: "86073904-b832-43a1-9807-cba6acc0bf2f",
  },
] as const;
const expectedPrior = {
  mode: "targeted" as const,
  target: [{ id: 39, region: "aws:eu-central-1", type: "region" as const }],
};

/** This exception describes two known damaged deployments. It never normalizes arbitrary missing placement. */
export function pendingPlacementRepair(input: {
  role: string;
  scriptName: string;
  deploymentId: string;
  baseline: readonly { versionId: string; percentage: number }[];
  active: ActiveWorkerPlacement;
  prior: ActiveWorkerPlacement;
  metadata: Workers.PutScriptMetadata;
  settings: Workers.GetScriptScriptAndVersionSettingResponse;
  retired: boolean;
}) {
  const target = placementRepairTargets.find(
    (target) => target.role === input.role && target.scriptName === input.scriptName,
  );
  if (
    !target ||
    input.retired ||
    input.deploymentId !== target.deployment ||
    canonical(input.baseline) !== canonical([{ versionId: target.version, percentage: 100 }]) ||
    input.active.id !== target.version ||
    input.active.placement != null ||
    input.prior.id !== target.prior ||
    canonical(input.prior.placement) !== canonical(expectedPrior) ||
    canonical(input.settings.placement ?? {}) !== "{}" ||
    canonical(normalizePlacement(input.metadata.placement)) !==
      canonical(normalizePlacement(expectedPrior))
  )
    throw new BarrierRefusal("pending-placement-repair-not-admitted", input.role);
  // Other differences still go through the ordinary complete settings comparison.
  assertScriptSettings(input.role, input.scriptName, input.metadata, {
    ...input.settings,
    placement: expectedPrior,
  });
  return {
    role: target.role,
    scriptName: target.scriptName,
    deploymentId: target.deployment,
    activeVersion: target.version,
    priorVersion: target.prior,
    before: {},
    after: { mode: "targeted" as const, target: [39] },
    region: "aws:eu-central-1" as const,
    disposition: "pending-placement-repair" as const,
  };
}

export const placementRepairReceipt = Schema.Struct({
  role: Schema.Literals(["Api", "AppPages"]),
  scriptName: Schema.String,
  deploymentId: Schema.String,
  activeVersion: Schema.String,
  priorVersion: Schema.String,
  before: Schema.Struct({}),
  after: Schema.Struct({ mode: Schema.Literal("targeted"), target: Schema.Array(Schema.Number) }),
  region: Schema.Literal("aws:eu-central-1"),
  disposition: Schema.Literal("pending-placement-repair"),
});
export type PendingPlacementRepair = typeof placementRepairReceipt.Type;

export function assertRepairedPlacement(
  role: string,
  versionId: string,
  version: ActiveWorkerPlacement,
  settings: { readonly placement?: unknown },
) {
  assertRepairedVersionPlacement(role, versionId, version);
  if (canonical(settings.placement ?? null) !== canonical({ mode: "targeted", target: [39] }))
    throw new BarrierRefusal("placement-repair-readback-drift", role);
}

export function assertRepairedVersionPlacement(
  role: string,
  versionId: string,
  version: ActiveWorkerPlacement,
) {
  if (version.id !== versionId || canonical(version.placement ?? null) !== canonical(expectedPrior))
    throw new BarrierRefusal("placement-repair-version-drift", role);
}
