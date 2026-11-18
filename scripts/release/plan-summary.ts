import { havePropsChanged } from "alchemy/Diff";
import type * as AlchemyPlan from "alchemy/Plan";
import { safeJson } from "./safe-json.ts";

/** The slices of Alchemy's plan snapshot the release entry reads. */
export interface PlannedRow {
  readonly fqn: string;
  readonly resourceType: string;
  readonly action: string;
  readonly bindings: readonly { readonly sid?: string; readonly action: string }[];
}
export interface Snapshot {
  readonly resources: readonly PlannedRow[];
  readonly summary: Record<string, number>;
  readonly native: AlchemyPlan.Plan;
}

const changed = (before: unknown, after: unknown) => {
  try {
    // Alchemy's own diff: a stored, provider-normalised value is not a change.
    return havePropsChanged({ value: before }, { value: after });
  } catch {
    return safeJson(before) !== safeJson(after);
  }
};

/**
 * Non-noop rows, with only the names of changed top-level props (values can be secrets) and the
 * changed binding ids. Read it before apply: apply rewrites the plan it was handed.
 */
export const changedRows = (snapshot: Snapshot) =>
  snapshot.resources
    .filter(
      (row) => row.action !== "noop" || row.bindings.some((binding) => binding.action !== "noop"),
    )
    .map((row) => {
      const node = snapshot.native.resources[row.fqn] ?? snapshot.native.deletions[row.fqn];
      const before: Record<string, unknown> = node?.state?.props ?? {};
      const after: Record<string, unknown> = (node && "props" in node ? node.props : {}) ?? {};
      return {
        fqn: row.fqn,
        type: row.resourceType,
        action: row.action,
        changedProps: [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((key) => changed(before[key], after[key]))
          .sort(),
        bindings: row.bindings
          .filter((binding) => binding.action !== "noop")
          .map(({ sid, action }) => ({ sid, action })),
      };
    });

/**
 * What a fresh plan after apply still wants to change: names only, no props. A command that re-runs
 * on every deploy (`memo: false`) always plans as an update, so a command update is not a leftover.
 */
export const remainingRows = (snapshot: Snapshot) =>
  snapshot.resources
    .filter(
      (row) => row.action !== "noop" || row.bindings.some((binding) => binding.action !== "noop"),
    )
    .filter((row) => !(row.resourceType.startsWith("Command.") && row.action === "update"))
    .map((row) => ({ fqn: row.fqn, type: row.resourceType, action: row.action }));

/**
 * The deploy-time readiness command polls until the pool's Durable Object has adopted the new
 * code (Cloudflare defers that up to 300 s for an active object). A plan that updates PoolWorker
 * without it would hand acceptance the old code, and a failure inside that window would roll back.
 */
export const readinessCommand = "PoolBackendBudgetRuntimeReady";
export const updatesWorkerWithoutReadiness = (snapshot: Snapshot, poolWorker: string) =>
  snapshot.resources.some((row) => row.fqn === poolWorker && row.action !== "noop") &&
  !snapshot.resources.some((row) => row.fqn === readinessCommand && row.action !== "noop");

// The attributes providers record as a resource's own name or id (not ids it merely refers to).
const IDENTITY = [
  "workerName",
  "scriptName",
  "applicationId",
  "applicationName",
  "id",
  "name",
  "databaseId",
  "databaseName",
  "bucketName",
  "namespaceId",
  "configId",
  "queueId",
  "indexName",
] as const;

/** The names and ids of every resource a destroy plan deletes, read from their recorded rows. */
export const destroyTargets = (plan: AlchemyPlan.Plan) =>
  [...Object.values(plan.resources), ...Object.values(plan.deletions)].flatMap((node) => {
    if (!node || (node.action !== "delete" && node.action !== "orphaned")) return [];
    const attr = (node.state as { attr?: Record<string, unknown> } | undefined)?.attr ?? {};
    return IDENTITY.map((key) => attr[key]).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  });
