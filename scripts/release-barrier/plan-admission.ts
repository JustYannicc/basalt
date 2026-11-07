import type * as Plan from "alchemy/Plan";
import type { Worker } from "alchemy/Cloudflare";
import { BarrierRefusal, type PlanRefusal } from "./manifest.ts";
import { havePropsChanged } from "alchemy/Diff";
import { changedProps, publicPropPath } from "./prop-diff.ts";
import { firstVerificationCommand, supportedCommand } from "./commands.ts";

import { plannedReasons } from "./plan-reasons.ts";

const readinessId = "PoolBackendBudgetRuntimeReady";
const deploymentEnvironment = new Set([
  "CLOUDFLARE_ACCOUNT_ID",
  "DATABASE_BUDGET_WORKER",
  "GITHUB_SHA",
  "POOL_DEPLOYMENT_KEY",
  "DATABASE_BUDGET_IMAGE_HASH",
  "DATABASE_BUDGET_WORKER_INPUT",
  "DATABASE_BUDGET_RECEIPT",
  "DATABASE_BUDGET_DEPLOYMENT",
]);
const environment = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonDeploymentProps = ({ env, ...props }: Record<string, unknown>) => ({
  ...props,
  env: environment(env)
    ? Object.fromEntries(Object.entries(env).filter(([name]) => !deploymentEnvironment.has(name)))
    : (env ?? {}),
});
const recordedProps = (node: Plan.Apply) =>
  node.state?.status === "updating" ? node.state.old?.props : node.state?.props;
const lifecycle = (node: Plan.Apply) => node.state?.status ?? "absent";
function verificationEnvChanges(node: Plan.Apply) {
  const old = recordedProps(node)?.env;
  const next = node.resource.Props.env;
  const before = environment(old) ? old : {};
  const after = environment(next) ? next : {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((name) => havePropsChanged({ value: before[name] }, { value: after[name] }))
    .map((name) =>
      deploymentEnvironment.has(name) ? name : publicPropPath(["env", name]).slice(4),
    );
}
export interface VerificationAdmission {
  fqn: string;
  lifecycle: string;
  envChanges: string[];
}
export const verificationAdmissions = (plan: Plan.Plan): VerificationAdmission[] =>
  Object.values(plan.resources)
    .filter(
      (node) =>
        node.resource.FQN === readinessId &&
        node.resource.Type === "Command.Exec" &&
        firstVerificationCommand(node.resource.LogicalId, node.resource.Props),
    )
    .map((node) => ({
      fqn: readinessId,
      lifecycle: lifecycle(node),
      envChanges: verificationEnvChanges(node),
    }));

const workerType = "Cloudflare.Worker";
export const newVerification = (node: Plan.Apply) =>
  node.action === "create" &&
  (node.state === undefined ||
    (node.state.status === "creating" &&
      node.state.attr === undefined &&
      node.state.fqn === node.resource.FQN &&
      node.state.resourceType === node.resource.Type &&
      node.state.logicalId === node.resource.LogicalId &&
      !havePropsChanged(
        nonDeploymentProps(node.state.props),
        nonDeploymentProps(node.resource.Props),
      ))) &&
  node.resource.Type === "Command.Exec" &&
  node.resource.FQN === readinessId &&
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
      let changed = changedProps(recordedProps(node), node.resource.Props);
      if (node.resource.LogicalId === readinessId && node.resource.Type === "Command.Exec")
        changed = [
          ...changed.filter((change) => !/^env(?:\.|$)/u.test(change.path)),
          ...verificationEnvChanges(node).map((name) => ({
            path: `env.${name}`,
            changed: true as const,
          })),
        ];
      refusals.push({
        reason,
        fqn,
        type: node.resource.Type,
        changed,
        why: [
          `recorded lifecycle is ${lifecycle(node)}; planned action is ${node.action}`,
          ...(!changed.length
            ? [...plannedReasons(plan, node), ...(imageReasons.get(fqn) ?? [])]
            : []),
        ],
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
