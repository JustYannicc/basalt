import type * as Plan from "alchemy/Plan";
import { isResolved } from "alchemy/Diff";
import { canonical } from "./manifest.ts";
import type {
  BucketDeclaration,
  D1Declaration,
  DeclaredChanges,
} from "./declared-change-schema.ts";
import { classPlanMatches, classPlanChanges } from "./declared-class-contract.ts";
import { changedProps } from "./prop-diff.ts";
import type { PlanRefusal } from "./manifest.ts";

export function declarationRefusals(plan: Plan.Plan, declarations?: DeclaredChanges) {
  const refusals: PlanRefusal[] = [];
  for (const entry of declarations?.changes ?? []) {
    const node = plan.resources[entry.fqn];
    if (node && !declaredIntentMatches(node, entry))
      refusals.push({
        reason: "declaration-does-not-match-plan",
        fqn: entry.fqn,
        type: entry.type,
        changed: declaredIntentChanges(node, entry),
        why: ["Every declared property and identity must match, including noop resources."],
      });
    if (!Object.hasOwn(plan.resources, entry.fqn))
      refusals.push({
        reason: "declared-resource-missing-from-plan",
        fqn: entry.fqn,
        type: entry.type,
        changed: [{ path: "$declaration.resource", old: "declared", new: null }],
      });
    const count = declarations!.changes.filter((change) => change.fqn === entry.fqn).length;
    if (count > 1)
      refusals.push({
        reason: "duplicate-resource-declaration",
        fqn: entry.fqn,
        type: entry.type,
        changed: [{ path: "$declaration.count", old: 1, new: count }],
      });
  }
  return refusals;
}

type Declaration = DeclaredChanges["changes"][number];

export function declaredIntentChanges(node: Plan.Apply, entry: Declaration) {
  if (entry.action === "add-sqlite-class") return classPlanChanges(node, entry);
  return changedProps(
    { ...entry.props, type: entry.type, fqn: entry.fqn, removalPolicy: entry.removalPolicy },
    {
      ...node.resource.Props,
      type: node.resource.Type,
      fqn: node.resource.FQN,
      removalPolicy: node.resource.RemovalPolicy,
    },
  );
}

export function declaredIntentMatches(node: Plan.Apply, entry: Declaration) {
  if (entry.action === "add-sqlite-class") return classPlanMatches(node, entry);
  return (
    node.resource.Type === entry.type &&
    node.resource.FQN === entry.fqn &&
    node.resource.RemovalPolicy === entry.removalPolicy &&
    isResolved(node.resource.Props) &&
    canonical(node.resource.Props) === canonical(entry.props)
  );
}

function declaredStorageCreate(
  node: Plan.Apply,
  declarations: DeclaredChanges | undefined,
  action: BucketDeclaration["action"] | D1Declaration["action"],
) {
  const entry = declarations?.changes.find((change) => change.fqn === node.resource.FQN);
  return (
    !!entry &&
    entry.action === action &&
    declaredIntentMatches(node, entry) &&
    node.action === "create" &&
    !node.renamedFrom?.length &&
    (!node.state ||
      (node.state.status === "creating" &&
        node.state.fqn === entry.fqn &&
        node.state.resourceType === entry.type &&
        node.state.removalPolicy === "retain" &&
        canonical(node.state.props) === canonical(entry.props)))
  );
}
export const declaredBucketCreate = (node: Plan.Apply, declarations?: DeclaredChanges) =>
  declaredStorageCreate(node, declarations, "create-bucket");
export const declaredD1Create = (node: Plan.Apply, declarations?: DeclaredChanges) =>
  declaredStorageCreate(node, declarations, "create-d1-database");
