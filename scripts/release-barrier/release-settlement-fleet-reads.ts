import { Schema } from "effect";
import { RuntimeColorSchema, type RuntimeColor } from "../../src/pool/image-release-plan.ts";
import {
  FleetConfigurationRecord,
  type FleetConfiguration,
} from "../../src/pool/runtime-fleet/configuration.ts";
import {
  SlotTarget,
  sameControllerCode,
  sameIdentity,
  type ControllerCode,
  type SlotSelection,
} from "../../src/pool/runtime-slots/contract.ts";
import {
  fleetRowsOnActive,
  releaseFleetApplications,
  releaseInactiveColor,
} from "./runtime-release-fleet.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { BaselineController, BaselineRead } from "./baseline-controller.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import {
  observed,
  readResult,
  readSelectedController,
} from "./release-settlement-controller-reads.ts";

const strict = { onExcessProperty: "error" } as const;
const Fleet = Schema.Struct({
  permission: Schema.optional(FleetConfigurationRecord),
  resources: Schema.Array(Schema.Unknown),
  bindings: Schema.Array(
    Schema.Struct({
      color: RuntimeColorSchema,
      applicationId: Schema.String,
      imageInput: Schema.String,
    }),
  ),
});
// Only the fields the proof judges; the rest of each row is the fleet's own bookkeeping.
const Row = Schema.Struct({ target: SlotTarget, phase: Schema.String });
// Unknown provider state stays fail-closed; every other phase is the fleet's ordinary lifecycle.
const unsettledPhases = new Set(["uncertain", "quarantined"]);
const fleetRefusal = (guard: string, values?: Record<string, unknown>) =>
  observed(new BarrierRefusal("release-settlement-fleet-unexpected", `fleet.${guard}`), values);
type FleetRecord = Pick<RuntimeReleaseRecord, "baseline" | "configurations" | "baselineController">;
// recoverPrimary rewrites only these; every other field is the configuration the source sent.
const recoveredFields = ({
  legacy: _legacy,
  revision: _revision,
  previousDigest: _previousDigest,
  ...configuration
}: FleetConfiguration) => configuration;
const byColor = (applications: readonly { color: string }[]) =>
  [...applications].sort((left, right) => left.color.localeCompare(right.color));

/**
 * Judges the live permission by its content, since recovery and an adopting release both leave one
 * the record never retained: recoverPrimary rewrites `legacy`, `revision` and the chained digest
 * under the same operation, and an adopting release that stopped before its own configure still
 * runs its source's. It must declare exactly the baseline's fleet pins, beside the live selection,
 * for this controller object, from the live code or the controller this record froze. Its active
 * colour must be the one the next release keeps serving (releaseInactiveColor), or its image
 * update would build the colour the fleet runs on. A permission under an operation the source
 * retained must still be that configuration, apart from the fields recovery rewrites.
 */
function permissionFailure(
  permission: { operationId: string; digest: string; configuration: FleetConfiguration },
  selection: typeof SlotSelection.Type,
  record: FleetRecord,
  liveCode: ControllerCode,
) {
  const { configuration } = permission;
  let declared;
  try {
    declared = releaseFleetApplications(record);
  } catch {
    return "permission.applications";
  }
  const retained = record.configurations[permission.operationId];
  const codes = [liveCode, record.baselineController?.code].filter((code) => code !== undefined);
  const guards: [string, boolean][] = [
    ["permission.digest", digest(canonical(configuration)) === permission.digest],
    [
      "permission.applications",
      canonical(byColor(configuration.applications)) === canonical(byColor(declared)),
    ],
    [
      "permission.legacy",
      !!selection.active.identity && sameIdentity(configuration.legacy, selection.active.identity),
    ],
    [
      "permission.controller",
      configuration.controllerId === selection.active.target.controllerId &&
        codes.some((code) => sameControllerCode(configuration.controllerCode, code)),
    ],
    [
      "permission.active",
      configuration.active !==
        releaseInactiveColor(
          undefined,
          configuration.applications,
          selection.active.target.applicationId,
        ),
    ],
    [
      "permission.retained",
      !retained ||
        (retained.revision <= configuration.revision &&
          canonical(recoveredFields(retained)) === canonical(recoveredFields(configuration))),
    ],
  ];
  return guards.find(([, ok]) => !ok)?.[0];
}

/**
 * The fleet attached beside the selected root. Each binding is a baseline fleet colour's own
 * application on its retained image; the source's code phases link every native colour, whichever
 * release created it. Under a permission the fleet serves demand, so its rows may run only the
 * permission's active application on its full pins (fleetRowsOnActive), the rows the next
 * release's previous-generation wait also accepts. Rows change with demand, so the digest covers
 * only the permission and bindings.
 */
export async function readAttachedFleet(
  response: Response,
  signal: AbortSignal,
  selection: typeof SlotSelection.Type,
  record: FleetRecord,
  liveCode: ControllerCode,
) {
  const fleet = Schema.decodeUnknownSync(Fleet, strict)(await readResult(response, signal));
  const seen = new Set<RuntimeColor>();
  for (const binding of fleet.bindings) {
    const application = record.baseline.applications[binding.color];
    if (
      !application ||
      seen.has(binding.color) ||
      binding.applicationId !== application.attributes.applicationId ||
      binding.imageInput !== application.image.inputHash
    )
      throw fleetRefusal(`binding.${binding.color}`);
    seen.add(binding.color);
  }
  const { permission } = fleet;
  const refused = permission && permissionFailure(permission, selection, record, liveCode);
  if (refused) throw fleetRefusal(refused);
  const rows = fleet.resources.map((value) => Schema.decodeUnknownSync(Row)(value));
  if (
    rows.length &&
    (!permission ||
      rows.some((row) => unsettledPhases.has(row.phase)) ||
      !fleetRowsOnActive(
        rows,
        permission.configuration.applications,
        permission.configuration.active,
      ))
  )
    throw fleetRefusal("resources", { observed: rows.length });
  return {
    digest: digest(canonical({ permission: permission ?? null, bindings: fleet.bindings })),
    permission: permission ? ("present" as const) : ("absent" as const),
    active: permission?.configuration.active,
  };
}

/**
 * The adopted root still selected, serving and witnessed exactly as `readAdoptedController` proves
 * it, with nothing staged, and the fleet attached beside it. Each bootstrap the source journaled
 * froze the active application it ran beside; the selection must still be that application.
 */
export async function readFleetAttachedController(input: {
  controller: BaselineController;
  key: string;
  sourceCandidate: string;
  record: FleetRecord & Pick<RuntimeReleaseRecord, "bootstrap">;
  colors: readonly RuntimeColor[];
  instances: readonly string[];
  target?: PoolOperationsTarget;
  /** Records each signed read, as `readAdoptedController`'s `record` does. */
  read?(call: BaselineRead): Promise<void>;
}) {
  const { record } = input;
  const result = await readSelectedController(
    {
      controller: input.controller,
      key: input.key,
      sourceCandidate: input.sourceCandidate,
      root: record.baseline.applications.root,
      instances: input.instances,
      ...(input.target ? { target: input.target } : {}),
      ...(input.read ? { record: input.read } : {}),
    },
    (response, signal, selection) =>
      readAttachedFleet(response, signal, selection, record, input.controller.code),
  );
  const { selection } = result.reads;
  for (const [color, manifest] of Object.entries(record.bootstrap))
    if (
      selection.identity.applicationId !== manifest.active.applicationId ||
      selection.epoch < manifest.active.selectionEpoch
    )
      throw observed(
        new BarrierRefusal("release-settlement-bootstrap-active-drift", `bootstrap.${color}`),
        { expected: manifest.active.selectionEpoch, observed: selection.epoch },
      );
  // The serving colour is derived from the permission the fleet digest records, so it stays out.
  return {
    ...result,
    servingColor: result.fleet.active,
    reads: { ...result.reads, colors: [...input.colors], permission: result.fleet.permission },
  };
}
