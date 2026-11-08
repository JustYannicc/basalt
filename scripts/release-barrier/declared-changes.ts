import type * as Plan from "alchemy/Plan";
import { isResolved } from "alchemy/Diff";
import { canonical } from "./manifest.ts";
import type {
  BucketDeclaration,
  D1Declaration,
  DeclaredChanges,
} from "./declared-change-schema.ts";
import { changedProps } from "./prop-diff.ts";
import type { PlanRefusal } from "./manifest.ts";

export function declarationRefusals(plan: Plan.Plan, declarations?: DeclaredChanges) {
  const refusals: PlanRefusal[] = [];
  for (const entry of declarations?.changes ?? []) {
    const node = plan.resources[entry.fqn];
    if (entry.action !== "create-bucket" && entry.action !== "create-d1-database")
      refusals.push({
        reason: "unsupported-declared-operation",
        fqn: entry.fqn,
        type: entry.type,
        changed: [{ path: "$declaration.action", old: null, new: entry.action }],
      });
    else if (node && !declaredIntentMatches(node, entry))
      refusals.push({
        reason: "declaration-does-not-match-plan",
        fqn: entry.fqn,
        type: entry.type,
        changed: changedProps(
          { ...entry.props, type: entry.type, fqn: entry.fqn, removalPolicy: entry.removalPolicy },
          {
            ...node.resource.Props,
            type: node.resource.Type,
            fqn: node.resource.FQN,
            removalPolicy: node.resource.RemovalPolicy,
          },
        ),
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

export function declaredBucketCreate(node: Plan.Apply, declarations?: DeclaredChanges) {
  const entry = declarations?.changes.find((change) => change.fqn === node.resource.FQN);
  if (
    !entry ||
    entry.action !== "create-bucket" ||
    node.resource.Type !== entry.type ||
    node.action !== "create" ||
    (node.state !== undefined &&
      (node.state.status !== "creating" ||
        node.state.fqn !== node.resource.FQN ||
        node.state.resourceType !== node.resource.Type ||
        node.state.removalPolicy !== "retain" ||
        canonical(node.state.props) !== canonical(entry.props))) ||
    node.renamedFrom?.length ||
    node.resource.RemovalPolicy !== "retain" ||
    !isResolved(node.resource.Props)
  )
    return false;
  return canonical(node.resource.Props) === canonical(entry.props);
}

export function declaredIntentMatches(node: Plan.Apply, entry: BucketDeclaration | D1Declaration) {
  return (
    node.resource.Type === entry.type &&
    node.resource.FQN === entry.fqn &&
    node.resource.RemovalPolicy === entry.removalPolicy &&
    isResolved(node.resource.Props) &&
    canonical(node.resource.Props) === canonical(entry.props)
  );
}

export function declaredD1Create(node: Plan.Apply, declarations?: DeclaredChanges) {
  const entry = declarations?.changes.find((change) => change.fqn === node.resource.FQN);
  return (
    !!entry &&
    entry.action === "create-d1-database" &&
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
