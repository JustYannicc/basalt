import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import { Data } from "effect";
import type * as AlchemyPlan from "alchemy/Plan";
import { propChanges } from "./plan-check.ts";
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
 * The upstream resources a value still waits on at plan time, by name: a prop that only refers to a
 * resource this plan changes is unresolved, and Alchemy's diff calls it changed for that alone.
 */
const waitsOn = (value: unknown) => {
  const upstreams = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (part: unknown, depth: number) => {
    if (Output.isExpr(part) && !isResolved(part)) {
      for (const upstream of Object.keys(Output.upstreamAny(part))) upstreams.add(upstream);
      return;
    }
    if (!part || typeof part !== "object" || seen.has(part) || depth > 12) return;
    seen.add(part);
    const parts = Array.isArray(part)
      ? part
      : Object.getPrototypeOf(part) === Object.prototype
        ? Object.values(part)
        : [];
    for (const next of parts) walk(next, depth + 1);
  };
  walk(value, 0);
  return [...upstreams].sort();
};

/**
 * Non-noop rows, with only the names of changed top-level props (values can be secrets), the
 * resources each still waits on, and the changed binding ids. Read it before apply: apply rewrites
 * the plan it was handed.
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
      const changedProps = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => changed(before[key], after[key]))
        .sort();
      return {
        fqn: row.fqn,
        type: row.resourceType,
        action: row.action,
        changedProps,
        waitsOn: Object.fromEntries(
          changedProps.flatMap((key) => {
            const upstreams = waitsOn(after[key]);
            return upstreams.length ? [[key, upstreams] as const] : [];
          }),
        ),
        bindings: row.bindings
          .filter((binding) => binding.action !== "noop")
          .map(({ sid, action }) => ({ sid, action })),
      };
    });

/**
 * Why Alchemy plans a row as changed, read from the plan alone: no settled State row, an input not
 * known until another row resolves, or a binding path that differs from the recorded one. Values
 * are shown only when their form cannot hold a secret; expressions are described, never evaluated.
 */
export function plannedReasons(plan: AlchemyPlan.Plan, fqn: string): string[] {
  const node = plan.resources[fqn] ?? plan.deletions[fqn];
  if (!node) return [];
  const reasons = new Set<string>();
  const state = node.state as
    | {
        status?: string;
        bindings?: ReadonlyArray<{ sid: string; data: unknown }>;
        old?: { bindings?: ReadonlyArray<{ sid: string; data: unknown }> };
      }
    | undefined;
  if (!state) reasons.add("no recorded State row: first creation planned");
  else if (state.status && !["created", "updated"].includes(state.status))
    reasons.add(`recorded lifecycle is ${state.status}`);
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: readonly string[]) => {
    if (Output.isExpr(value) && !isResolved(value)) {
      for (const upstream of Object.keys(Output.upstreamAny(value)))
        reasons.add(
          `${path.join(".")} unknown until ${upstream} (${plan.resources[upstream]?.action ?? "resolve"}) resolves`,
        );
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value) || path.length > 12) return;
    seen.add(value);
    if (Array.isArray(value)) value.forEach((part, index) => walk(part, [...path, String(index)]));
    else if (Object.getPrototypeOf(value) === Object.prototype)
      for (const [key, part] of Object.entries(value)) walk(part, [...path, key]);
  };
  const declared = "props" in node ? node.props : node.resource.Props;
  walk(declared, ["props"]);
  // Only keys Alchemy's own comparison calls changed, a few levels deep: a stored, provider-normalised
  // value is not a change, and resolved resources inside props refer back to each other.
  const recordedProps = (state as { props?: Record<string, unknown> } | undefined)?.props ?? {};
  if (state && "props" in node && declared && typeof declared === "object")
    for (const key of Object.keys({
      ...recordedProps,
      ...(declared as Record<string, unknown>),
    }).sort())
      if (changed(recordedProps[key], (declared as Record<string, unknown>)[key]))
        for (const change of propChanges(
          recordedProps[key],
          (declared as Record<string, unknown>)[key],
          ["props", key],
          4,
        ).filter((line) => !line.includes("<unresolved>")))
          reasons.add(change);
  const recorded = new Map(
    (state?.status === "updating" ? state.old?.bindings : state?.bindings)?.map((binding) => [
      binding.sid,
      binding.data,
    ]) ?? [],
  );
  for (const binding of node.bindings ?? []) {
    walk(binding.data, ["bindings", binding.sid]);
    if (binding.action === "noop") continue;
    try {
      const changes = propChanges(
        recorded.get(binding.sid),
        binding.action === "delete" ? undefined : binding.data,
        ["bindings", binding.sid],
      );
      for (const change of changes) reasons.add(change);
      if (!changes.length)
        reasons.add(`bindings.${binding.sid}: ${binding.action}, no leaf differs`);
    } catch {
      reasons.add(`bindings.${binding.sid}: ${binding.action}`);
    }
  }
  if (!reasons.size)
    reasons.add(
      "the provider asked for this change with unchanged props and resolved bindings: the difference is on the provider's side",
    );
  return [...reasons].slice(0, 12);
}

/**
 * What a fresh plan after apply still wants to change: the names of the properties and bindings
 * that differ, and why Alchemy plans them. A command that re-runs on every deploy (`memo: false`)
 * always plans as an update, so a command update is not a leftover.
 */
export const remainingRows = (snapshot: Snapshot) =>
  changedRows(snapshot)
    .filter((row) => !(row.type.startsWith("Command.") && row.action === "update"))
    .map(({ fqn, type, action, changedProps, bindings }) => ({
      fqn,
      type,
      action,
      changedProps,
      bindings: bindings.map((binding) => binding.sid ?? "?"),
      reasons: plannedReasons(snapshot.native, fqn),
    }));

/**
 * A plan that still wants changes right after its apply: the rows and the names of the properties
 * and bindings that differ. Names come from our own source, so they are printed in public.
 */
export class ChangesRemainAfterApply extends Data.TaggedError("ChangesRemainAfterApply")<{
  readonly check: "read-back";
  readonly why: string;
  readonly fix: string;
  readonly remaining: readonly string[];
  /** Why each row is planned: values a reason shows can be names, so they stay private. */
  readonly detail: readonly { readonly row: string; readonly reasons: readonly string[] }[];
}> {
  static of(rows: ReturnType<typeof remainingRows>) {
    return new ChangesRemainAfterApply({
      check: "read-back",
      why: "A fresh plan right after the apply still changes these rows, so the apply did not settle.",
      fix: "Find the input that differs on every plan (a per-run value, or a command that always re-runs) and settle it at its source.",
      remaining: rows.map(
        (row) =>
          `${row.fqn} (${row.type} ${row.action}: ${[...row.changedProps, ...row.bindings.map((sid) => `binding ${sid}`)].join(", ") || "no named property"})`,
      ),
      detail: rows.map((row) => ({ row: row.fqn, reasons: row.reasons })),
    });
  }
}

/**
 * The deploy-time readiness command polls until the pool's Durable Object has adopted the new
 * code (Cloudflare defers that up to 300 s for an active object). A plan that updates PoolWorker
 * without it would hand acceptance the old code, and a failure inside that window would roll back.
 */
export const readinessCommand = "PoolBackendBudgetRuntimeReady";
export const updatesWorkerWithoutReadiness = (snapshot: Snapshot, poolWorker: string) =>
  snapshot.resources.some((row) => row.fqn === poolWorker && row.action !== "noop") &&
  !snapshot.resources.some((row) => row.fqn === readinessCommand && row.action !== "noop");

type Attr = Readonly<Record<string, unknown>>;
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : "");
const own =
  (key: string) =>
  (attr: Attr): string[] =>
    text(attr[key]) ? [text(attr[key])] : [];
// A branch or role is named only inside its database, so its target carries the path above it;
// the same id on another database (production's) is never the plan's.
const inDatabase =
  (...keys: ReadonlyArray<readonly [string, string]>) =>
  (attr: Attr): string[] => {
    const parts = keys.map(([segment, key]) => [segment, text(attr[key])] as const);
    if (!text(attr.database) || parts.some(([, value]) => !value)) return [];
    return [
      [text(attr.database), ...parts.flatMap(([segment, value]) => [segment, value])].join("/"),
    ];
  };

/**
 * Each resource type, the kind the wire guard names its delete path by, and the one attribute (as
 * Alchemy records it) that the delete path carries. Ids a row only refers to, such as a Workflow's
 * host Worker, are never targets.
 */
const KINDS: ReadonlyArray<readonly [RegExp, string, (attr: Attr) => string[]]> = [
  [/^Cloudflare\.Worker$/u, "Worker", own("workerName")],
  [/^Cloudflare\.Container/u, "container application", own("applicationId")],
  [/^Cloudflare\.R2\./u, "R2 bucket", own("bucketName")],
  [/^Cloudflare\.D1/u, "D1 database", own("databaseId")],
  [/^Cloudflare\.Hyperdrive/u, "Hyperdrive config", own("hyperdriveId")],
  [/^Cloudflare\.KV/u, "KV namespace", own("namespaceId")],
  [/^Cloudflare\.Queue/u, "Queue", own("queueId")],
  [/^Cloudflare\.Vectorize/u, "Vectorize index", own("indexName")],
  [/^Cloudflare\.Workflow$/u, "Workflow", own("workflowName")],
  // The account's one store is shared with production: a stage never deletes it.
  [/^Cloudflare\.SecretsStore/u, "Secrets Store store", () => []],
  [/^Cloudflare\.ApiToken\./u, "API token", own("tokenId")],
  [/^Planetscale\.(?:Postgres)?Database$/u, "PlanetScale database", own("name")],
  [/^Planetscale\.(?:Postgres)?Branch$/u, "PlanetScale branch", inDatabase(["branches", "name"])],
  [
    /^Planetscale\.(?:Postgres)?Role$/u,
    "PlanetScale role",
    inDatabase(["branches", "branch"], ["roles", "id"]),
  ],
];

/**
 * Every resource a destroy plan deletes, as the kind and the name or id its recorded row holds.
 * A type with no kind yields nothing, so its delete stays refused and the destroy says which.
 */
export const destroyTargets = (plan: AlchemyPlan.Plan) =>
  [...Object.values(plan.resources), ...Object.values(plan.deletions)].flatMap((node) => {
    if (!node || (node.action !== "delete" && node.action !== "orphaned")) return [];
    const state = node.state as
      | { attr?: Record<string, unknown>; resourceType?: unknown }
      | undefined;
    const type = String(
      state?.resourceType ?? (node as { resource?: { Type?: unknown } }).resource?.Type ?? "",
    );
    const found = KINDS.find(([pattern]) => pattern.test(type));
    if (!found) return [];
    const [, kind, ids] = found;
    return ids(state?.attr ?? {}).map((id) => ({ kind, id }));
  });
