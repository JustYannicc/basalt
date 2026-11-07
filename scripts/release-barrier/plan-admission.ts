import type * as Plan from "alchemy/Plan";
import type { Worker } from "alchemy/Cloudflare";
import { BarrierRefusal, type PlanRefusal } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";
import { firstVerificationCommand, supportedCommand } from "./commands.ts";

import { plannedReasons } from "./plan-reasons.ts";

const workerType = "Cloudflare.Worker";
export const newVerification = (node: Plan.Apply) =>
  node.action === "create" &&
  (node.state === undefined ||
    (node.state.status === "creating" && node.state.attr === undefined)) &&
  node.resource.Type === "Command.Exec" &&
  firstVerificationCommand(node.resource.LogicalId, node.resource.Props);
const existing = (node: Plan.Apply) =>
  node.state?.status === "created" ||
  node.state?.status === "updated" ||
  (node.state?.status === "updating" && !node.state.adopting && !!node.state.old);
/** No live resource lifecycle runs during shadow preparation. Commands expose only their real output contract. */
export function assertSupportedPlan(
  plan: Plan.Plan,
  imageReasons: ReadonlyMap<string, string[]> = new Map(),
) {
  const refusals: PlanRefusal[] = [];
  if (plan.selectedFqns || plan.destroy) refusals.push({ reason: "partial-or-destroy-plan" });
  for (const [fqn, saved] of Object.entries(plan.deletions))
    refusals.push({
      reason: "resource-removal-or-action",
      fqn,
      type: saved?.resource.Type ?? "Alchemy.Unknown",
      changed: [{ path: "$resource", old: "present", new: null }],
    });
  for (const [values, old, next] of [
    [plan.actionDeletions, "present", null],
    [plan.actions, null, "present"],
  ] as const)
    for (const fqn of Object.keys(values))
      refusals.push({
        reason: "resource-removal-or-action",
        fqn,
        type: "Alchemy.Action",
        changed: [{ path: "$action", old, new: next }],
      });
  for (const [fqn, node] of Object.entries(plan.resources)) {
    const refuseNode = (reason: string) => {
      const recorded =
        node.state?.status === "updating" ? node.state.old?.props : node.state?.props;
      const changed = changedProps(recorded, node.resource.Props);
      refusals.push({
        reason,
        fqn,
        type: node.resource.Type,
        changed,
        ...(!changed.length || reason === "new-or-unsettled-resource"
          ? { why: [...plannedReasons(plan, node), ...(imageReasons.get(fqn) ?? [])] }
          : {}),
      });
    };
    if (
      (!newVerification(node) && (!existing(node) || !["update", "noop"].includes(node.action))) ||
      node.renamedFrom?.length
    )
      refuseNode("new-or-unsettled-resource");
    if (node.resource.Type === workerType) {
      const props = node.resource.Props as Worker["Props"];
      if (props.namespace != null || props.preview != null || props.version != null)
        refuseNode("unsupported-worker-mode");
    } else if (node.resource.Type === "Cloudflare.Container" && node.action === "update") {
      if (node.resource.LogicalId !== "PoolContainer") refuseNode("unsupported-container");
    } else if (
      node.resource.Type !== "Command.Exec" &&
      node.resource.Type !== "Command.Build" &&
      node.action !== "noop"
    ) {
      // Returning an old image/application attribute would freeze the wrong PoolWorker input.
      refuseNode("unsupported-resource-update");
    }
    if (node.resource.Type === "Command.Exec" && !supportedCommand(node.resource.LogicalId))
      refuseNode("unsupported-command");
    if (node.resource.Type === "Command.Build" && node.resource.LogicalId !== "Site")
      refuseNode("unsupported-build-command");
  }
  const first = refusals[0];
  if (first) {
    const delta =
      "fqn" in first
        ? {
            fqn: first.fqn,
            type: first.type,
            changed: first.changed,
            ...(first.why ? { why: first.why } : {}),
          }
        : undefined;
    throw new BarrierRefusal(first.reason, delta?.fqn, delta, refusals);
  }
}
