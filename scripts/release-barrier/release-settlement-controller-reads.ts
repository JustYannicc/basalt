import { Option, Schema } from "effect";
import { runtimeResponseDiagnostic } from "../../src/pool/runtime-route-diagnostic.ts";
import { UnattestedAdoptionReadback } from "../../src/pool/runtime-slots/adoption-readback.ts";
import { StartupWitness } from "../../src/pool/runtime-slots/admission-proof.ts";
import {
  ControllerCode,
  SlotIdentity,
  SlotSelection,
  sameControllerCode,
  sameIdentity,
  sameTarget,
} from "../../src/pool/runtime-slots/contract.ts";
import { bounded } from "../database-budget-readiness.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import {
  handoffRead,
  readUnselectedInspection,
  withPoolOperations,
  type BaselineController,
  type BaselineRead,
} from "./baseline-controller.ts";
import { legacyAdoptionTarget } from "./legacy-adoption-target.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import type { RuntimeReleaseState } from "./runtime-release-state.ts";

/** The live controller's handoff answers a witness read for a slot it never recorded with this closed reason. */
export const missingWitnessReason = "slot_identity";

const refuse = (reason: string) => new BarrierRefusal(reason, "PoolWorker");
const Fleet = Schema.Struct({
  permission: Schema.optional(Schema.Unknown),
  resources: Schema.Array(Schema.Unknown),
  bindings: Schema.Array(Schema.Unknown),
});

/** A fleet that was never configured: no permission, resources or bindings. */
async function readEmptyFleet(listed: Response, signal: AbortSignal) {
  const result = await readResult(listed, signal);
  const fleet = Schema.decodeUnknownSync(Fleet, { onExcessProperty: "error" })(result);
  if (fleet.permission !== undefined || fleet.resources.length || fleet.bindings.length)
    throw refuse("release-settlement-fleet-present");
  return digest(canonical(fleet));
}

export async function readResult(response: Response, signal: AbortSignal) {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw refuse("release-settlement-controller-read-refused");
  }
  return Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
    onExcessProperty: "error",
  })(await bounded(response.json(), signal)).result;
}

/** Names the observed answer, so an operator learns what adopt left behind from the plan alone. */
async function witnessUnproven(response: Response) {
  await response.body?.cancel();
  const reason = runtimeResponseDiagnostic(response)?.runtimeReason;
  return new BarrierRefusal(
    "release-settlement-witness-unproven",
    `PoolWorker.witness.${response.status}.${reason ?? "none"}`,
  );
}

/** Three read-only sends prove the activated controller never adopted, configured or selected a runtime. */
export function readUnadoptedController(input: {
  controller: BaselineController;
  key: string;
  root: RuntimeReleaseState["applications"]["root"];
  instanceId: string;
  target?: PoolOperationsTarget;
  record?(call: BaselineRead): Promise<void>;
}) {
  const target = legacyAdoptionTarget(input.root, input.instanceId);
  return withPoolOperations(input.target ?? input.controller.target, async (bridge, signal) => {
    const send = (action: Parameters<typeof handoffRead>[0]["action"]) =>
      handoffRead({
        bridge,
        key: input.key,
        code: input.controller.code,
        action,
        signal,
        record: input.record,
      });
    const fleetDigest = await readEmptyFleet(await send({ action: "fleet-inspect" }), signal);
    const witness = await send({ action: "witness", target });
    if (witness.status === 200) {
      await witness.body?.cancel();
      throw refuse("release-settlement-retained-adoption");
    }
    // For example a witness without a committed selection answers slot_selection.
    if (
      witness.status !== 409 ||
      runtimeResponseDiagnostic(witness)?.runtimeReason !== missingWitnessReason
    )
      throw await witnessUnproven(witness);
    await witness.body?.cancel();
    await readUnselectedInspection(
      await send({ action: "inspect" }),
      signal,
      input.controller.code,
      {
        refused: "release-settlement-controller-read-refused",
        codePath: "release-settlement.controller-code",
        selection: "release-settlement-selection-present",
      },
    );
    return {
      fleetDigest,
      witness: "absent" as const,
      finalInspect: "no-selection" as const,
    };
  });
}

const Inspection = Schema.Struct({
  controllerCode: ControllerCode,
  selection: Schema.optional(SlotSelection),
});
const ActiveHealth = Schema.Struct({ identity: SlotIdentity, leaseMs: Schema.Number });
const selectionRefusal = (guard: string) =>
  new BarrierRefusal("release-settlement-adopted-selection-unexpected", `selection.${guard}`);
const witnessRefusal = (guard: string, values?: Record<string, unknown>) =>
  observed(
    new BarrierRefusal("release-settlement-adoption-witness-unexpected", `witness.${guard}`),
    values,
  );
const identifier = /^[a-zA-Z0-9-]{1,128}$/u;
/** Names non-secret drift in the message; the location stays a path and other values stay out. */
export function observed(refusal: BarrierRefusal, values: Record<string, unknown> = {}) {
  const shown = Object.entries(values).flatMap(([name, value]) =>
    (typeof value === "string" || typeof value === "number") && identifier.test(String(value))
      ? [`${name}=${value}`]
      : [],
  );
  if (shown.length) refusal.message += ` ${shown.join(" ")}`;
  return refusal;
}
const RecoveredWitness = Schema.Struct({
  kind: Schema.Literal("witness"),
  controllerCode: ControllerCode,
  witness: StartupWitness,
});
// Selected-runtime recovery names its restart after the first 48 hex of the digest of the boot it replaced.
const restartOperation = /^restart-[a-f0-9]{48}$/u;

/** Adopt's own grant still stands at epoch 1. */
function unattestedAdoption(
  raw: unknown,
  input: { sourceCandidate: string; code: typeof ControllerCode.Type; identity: SlotIdentity },
) {
  if (!Schema.is(Schema.Struct({ kind: Schema.Literal("unattested-active") }))(raw))
    throw witnessRefusal("kind");
  const witness = Schema.decodeUnknownSync(UnattestedAdoptionReadback)(raw);
  if (witness.operationId !== `adopt-${input.sourceCandidate}`) throw witnessRefusal("operationId");
  if (!sameIdentity(witness.identity, input.identity)) throw witnessRefusal("identity");
  if (!sameControllerCode(input.code, witness.controllerCode))
    throw witnessRefusal("controllerCode");
}

/**
 * Past epoch 1 only selected-runtime recovery commits, so the witness is the startup witness of the
 * active boot, launched by a `restart-<48 hex>` operation, which recovery commits only after attesting.
 */
function recoveredRestart(
  raw: unknown,
  input: { code: typeof ControllerCode.Type; identity: SlotIdentity },
) {
  if (!Schema.is(Schema.Struct({ kind: Schema.Literal("witness") }))(raw))
    throw witnessRefusal("kind");
  const decoded = Schema.decodeUnknownOption(RecoveredWitness, { onExcessProperty: "error" })(raw);
  if (Option.isNone(decoded)) throw witnessRefusal("shape");
  const { controllerCode, witness } = decoded.value;
  if (!sameControllerCode(controllerCode, input.code)) throw witnessRefusal("controllerCode");
  if (!sameTarget(witness.target, input.identity)) throw witnessRefusal("target");
  if (witness.bootId !== input.identity.bootId)
    throw witnessRefusal("bootId", { expected: input.identity.bootId, observed: witness.bootId });
  if (!restartOperation.test(witness.operationId)) throw witnessRefusal("operationId");
}

/**
 * Names what the selection moved to since `first`, so a restart during the plan, or between the plan
 * and its apply, explains itself.
 */
function selectionChanged(
  first: { epoch: number; bootId: string | undefined },
  final: { epoch: number; bootId: string | undefined } | undefined,
) {
  const refusal = (location: string) =>
    new BarrierRefusal("release-settlement-selection-changed", location);
  if (!final) return refusal("selection.absent");
  const boot = final.bootId;
  return final.epoch !== first.epoch || boot !== first.bootId
    ? observed(refusal("selection.epoch"), {
        expected: first.epoch,
        observed: final.epoch,
        observedBoot: boot,
      })
    : refusal("PoolWorker");
}

type ProvenSelection = { epoch: number; identity: SlotIdentity };
/** Apply refuses a selection other than the one its reviewed plan recorded, naming where it moved. */
export function assertSelectionUnchanged(planned: ProvenSelection, live: ProvenSelection) {
  if (live.epoch !== planned.epoch || !sameIdentity(live.identity, planned.identity))
    throw selectionChanged(
      { epoch: planned.epoch, bootId: planned.identity.bootId },
      { epoch: live.epoch, bootId: live.identity.bootId },
    );
}

/**
 * Once adopt commits a selection the recovery read refuses, so every read here is a signed handoff
 * read over one bridge. Together they prove the source's adopt left exactly the legacy root
 * selected, serving, with its witness, and that the fleet was never set up. Epoch 1 is adopt's own
 * commit with its unattested witness; a later epoch is the controller's own recovery of that root,
 * witnessed by the restart that launched its active boot.
 */
export const readAdoptedController = (input: AdoptedInput) =>
  readSelectedController(input, async (response, signal) => ({
    digest: await readEmptyFleet(response, signal),
  }));

type AdoptedInput = {
  controller: BaselineController;
  key: string;
  sourceCandidate: string;
  root: RuntimeReleaseState["applications"]["root"];
  /** Instances the root's live placement serves on the baseline image. */
  instances: readonly string[];
  target?: PoolOperationsTarget;
  record?(call: BaselineRead): Promise<void>;
};

/**
 * `readAdoptedController`'s reads with `fleet` proving the fleet-inspect answer against the
 * selection. Its whole verdict comes back as `fleet`; only its digest is recorded.
 */
export function readSelectedController<Fleet extends { digest: string }>(
  input: AdoptedInput,
  fleet: (
    response: Response,
    signal: AbortSignal,
    selection: typeof SlotSelection.Type,
  ) => Promise<Fleet>,
) {
  const { code } = input.controller;
  return withPoolOperations(input.target ?? input.controller.target, async (bridge, signal) => {
    const send = (action: Parameters<typeof handoffRead>[0]["action"], dispatched?: () => void) =>
      handoffRead({
        bridge,
        key: input.key,
        code,
        action,
        signal,
        record: input.record,
        dispatched,
      });
    // The live handoff refuses a command signed for another controller code as slot_identity.
    const inspect = async () => {
      const response = await send({ action: "inspect" });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw refuse(
          response.status === 409 &&
            runtimeResponseDiagnostic(response)?.runtimeReason === missingWitnessReason
            ? "release-settlement-controller-identity-refused"
            : "release-settlement-controller-read-refused",
        );
      }
      const value = Schema.decodeUnknownSync(Schema.Struct({ result: Inspection }))(
        await bounded(response.json(), signal),
      ).result;
      if (!sameControllerCode(code, value.controllerCode))
        throw refuse("release-settlement-controller-identity-refused");
      return value.selection;
    };
    const selection = await inspect();
    if (!selection) throw selectionRefusal("absent");
    if (selection.epoch < 1) throw selectionRefusal("epoch");
    const { active } = selection;
    if (
      !input.instances.some((instanceId) =>
        sameTarget(legacyAdoptionTarget(input.root, instanceId), active.target),
      )
    )
      throw selectionRefusal("target");
    if (
      !active.identity ||
      !sameIdentity(active.identity, { ...active.target, bootId: active.identity.bootId })
    )
      throw selectionRefusal("identity");
    if (active.fenced) throw selectionRefusal("fenced");
    if (active.retirement) throw selectionRefusal("retirement");
    if (selection.candidate) throw selectionRefusal("candidate");
    if (selection.draining) throw selectionRefusal("draining");
    const identity = active.identity;
    let sentAt = 0;
    // The lease runs from the fetch to its response only: not the bridge open, signing or
    // recording before it, nor decoding after it.
    const healthResponse = await send({ action: "active-health" }, () => {
      sentAt = performance.now();
    });
    const elapsed = performance.now() - sentAt;
    const health = Schema.decodeUnknownSync(ActiveHealth)(await readResult(healthResponse, signal));
    if (health.leaseMs <= elapsed) throw refuse("release-settlement-active-health-expired");
    if (!sameIdentity(health.identity, identity))
      throw refuse("release-settlement-active-health-identity");
    const fleetVerdict = await fleet(await send({ action: "fleet-inspect" }), signal, selection);
    const fleetDigest = fleetVerdict.digest;
    const witnessed = await send({ action: "witness", target: active.target });
    if (witnessed.status !== 200) throw await witnessUnproven(witnessed);
    const raw = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
      await bounded(witnessed.json(), signal),
    ).result;
    const adopted = selection.epoch === 1;
    if (adopted)
      unattestedAdoption(raw, { sourceCandidate: input.sourceCandidate, code, identity });
    else recoveredRestart(raw, { code, identity });
    const final = await inspect();
    if (!final || canonical(final) !== canonical(selection))
      throw selectionChanged(
        { epoch: selection.epoch, bootId: identity.bootId },
        final && { epoch: final.epoch, bootId: final.active.identity?.bootId },
      );
    return {
      instanceId: identity.instanceId,
      bootId: identity.bootId,
      fleet: fleetVerdict,
      reads: adopted
        ? {
            fleetDigest,
            witness: "unattested-adoption" as const,
            selection: { epoch: 1 as const, identity },
          }
        : {
            fleetDigest,
            witness: "recovered-restart" as const,
            selection: { epoch: selection.epoch, identity },
          },
    };
  });
}
