import { Schema } from "effect";
import { runtimeResponseDiagnostic } from "../../src/pool/runtime-route-diagnostic.ts";
import { bounded } from "../database-budget-readiness.ts";
import { openPoolOperations, type PoolOperationsTarget } from "../pool-operations.ts";
import {
  handoffRead,
  readUnselectedInspection,
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

/** Three read-only sends prove the activated controller never adopted, configured or selected a runtime. */
export async function readUnadoptedController(input: {
  controller: BaselineController;
  key: string;
  root: RuntimeReleaseState["applications"]["root"];
  instanceId: string;
  target?: PoolOperationsTarget;
  record?(call: BaselineRead): Promise<void>;
}) {
  const target = legacyAdoptionTarget(input.root, input.instanceId);
  const bridge = await openPoolOperations(input.target ?? input.controller.target);
  const signal = AbortSignal.timeout(30_000);
  const send = (action: Parameters<typeof handoffRead>[0]["action"]) =>
    handoffRead({
      bridge,
      key: input.key,
      code: input.controller.code,
      action,
      signal,
      record: input.record,
    });
  try {
    const listed = await send({ action: "fleet-inspect" });
    if (listed.status !== 200) {
      await listed.body?.cancel();
      throw refuse("release-settlement-controller-read-refused");
    }
    const fleet = Schema.decodeUnknownSync(Schema.Struct({ result: Fleet }), {
      onExcessProperty: "error",
    })(await bounded(listed.json(), signal)).result;
    if (fleet.permission !== undefined || fleet.resources.length || fleet.bindings.length)
      throw refuse("release-settlement-fleet-present");
    const witness = await send({ action: "witness", target });
    await witness.body?.cancel();
    if (witness.status === 200) throw refuse("release-settlement-retained-adoption");
    const reason = runtimeResponseDiagnostic(witness)?.runtimeReason;
    // The plan's witness read is how an operator learns what adopt left behind (for example a
    // witness without a committed selection answers slot_selection), so name the observed answer.
    if (witness.status !== 409 || reason !== missingWitnessReason)
      throw new BarrierRefusal(
        "release-settlement-witness-unproven",
        `PoolWorker.witness.${witness.status}.${reason ?? "none"}`,
      );
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
      fleetDigest: digest(canonical(fleet)),
      witness: "absent" as const,
      finalInspect: "no-selection" as const,
    };
  } finally {
    await bounded(bridge.close(), signal);
  }
}
