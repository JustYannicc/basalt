import type * as Plan from "alchemy/Plan";
import { generateInstanceId } from "alchemy/InstanceId";
import { State, isResourceState } from "alchemy/State/State";
import { havePropsChanged } from "alchemy/Diff";
import { Effect } from "effect";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import { declaredD1Create } from "./declared-changes.ts";
import { declarationHistory } from "./declared-history.ts";
import { declaredChecks } from "./declared-checks.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { d1Mismatch, d1Failure, type D1Provider, type PreparedD1 } from "./declared-d1-types.ts";

export const prepareDeclaredD1 = (
  plan: Plan.Plan,
  declarations: DeclaredChanges | undefined,
  scope: { stack: string; stage: string },
  provider: D1Provider,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const history = declarationHistory(yield* state.getOutput(scope));
    const prepared = new Map<string, PreparedD1>();
    yield* declaredChecks(
      Object.entries(plan.resources)
        .filter(([, node]) => declaredD1Create(node, declarations))
        .map(([fqn, node]) => ({
          fqn,
          type: "Cloudflare.D1Database" as const,
          check: Effect.gen(function* () {
            const saved = history.databases[fqn];
            const row = node.state;
            const persisted = yield* state.get({ ...scope, fqn });
            if (
              (!row && persisted) ||
              (row && (!isResourceState(persisted) || persisted.status !== "creating"))
            )
              throw d1Mismatch("alchemy-state-drift", fqn, row ?? {}, persisted ?? {});
            if (row && isResourceState(persisted)) {
              const { attr: observed, ...planned } = row;
              const { attr: actual, ...stored } = persisted;
              if (havePropsChanged(planned, stored) || actual !== undefined)
                throw d1Mismatch("alchemy-state-drift", fqn, planned, { ...stored, attr: actual });
              if (
                observed &&
                saved?.status === "acknowledged" &&
                (observed.databaseId !== saved.databaseId ||
                  observed.databaseName !== saved.target.databaseName ||
                  observed.accountId !== saved.target.accountId ||
                  observed.jurisdiction !== "eu")
              )
                throw d1Mismatch(
                  "declared-prerequisite-identity-mismatch",
                  fqn,
                  { ...saved.target, databaseId: saved.databaseId },
                  observed,
                );
            }
            if (!row && saved)
              throw d1Mismatch(
                "declared-resource-history-without-state",
                fqn,
                { nativeRow: "present" },
                { nativeRow: null },
              );
            if (row && (!saved || saved.status !== "acknowledged" || !saved.databaseId))
              throw d1Mismatch(
                "declared-d1-outcome-unknown",
                fqn,
                { outcome: "acknowledged" },
                { outcome: saved?.status ?? null },
              );
            if (node.downstream.length)
              throw new BarrierRefusal("declared-prerequisite-missing", fqn, {
                fqn,
                type: node.resource.Type,
                changed: [{ path: "$resource", old: null, new: "required-by-candidate" }],
                why: [
                  "Provision this database in a separate admitted release before adding its binding.",
                ],
              });
            const accountId = yield* Effect.promise(provider.accountId);
            yield* Effect.tryPromise({
              try: () => provider.preflight(accountId),
              catch: (error) => d1Failure(error, fqn, "preflight-d1", "deploy-token-lacks-d1"),
            });
            const entry = declarations!.changes.find((change) => change.fqn === fqn)!;
            if (entry.action !== "create-d1-database")
              throw d1Mismatch("declaration-does-not-match-plan", fqn, {}, entry);
            const target = {
              accountId,
              databaseName: entry.props.name,
              jurisdiction: "eu" as const,
            };
            const entryDigest = digest(canonical(entry));
            if (
              row &&
              (!saved ||
                saved.entry !== entryDigest ||
                saved.instanceId !== row.instanceId ||
                saved.providerVersion !== (node.provider.version ?? 0) ||
                canonical(saved.target) !== canonical(target) ||
                row.providerVersion !== saved.providerVersion ||
                row.providerMode !== node.mode ||
                row.logicalId !== node.resource.LogicalId)
            )
              throw d1Mismatch(
                "declared-prerequisite-identity-mismatch",
                fqn,
                {
                  entry: entryDigest,
                  target,
                  instanceId: saved?.instanceId,
                  providerVersion: node.provider.version ?? 0,
                  nativeProviderVersion: saved?.providerVersion,
                  providerMode: node.mode,
                  logicalId: node.resource.LogicalId,
                },
                {
                  entry: saved?.entry,
                  target: saved?.target,
                  instanceId: row.instanceId,
                  providerVersion: saved?.providerVersion,
                  nativeProviderVersion: row.providerVersion,
                  providerMode: row.providerMode,
                  logicalId: row.logicalId,
                },
              );
            const instanceId = row?.instanceId ?? (yield* generateInstanceId());
            prepared.set(fqn, {
              fqn,
              declaration: digest(canonical(declarations)),
              entry: entryDigest,
              target,
              ...(saved?.databaseId ? { databaseId: saved.databaseId } : {}),
              resume: row !== undefined,
              initialLifecycle: row ? "creating" : "absent",
              native:
                isResourceState(persisted) && persisted.status === "creating"
                  ? structuredClone(persisted)
                  : {
                      status: "creating",
                      fqn,
                      logicalId: node.resource.LogicalId,
                      instanceId,
                      namespace: node.resource.Namespace,
                      downstream: node.downstream,
                      props: structuredClone(node.resource.Props),
                      bindings: structuredClone(node.bindings),
                      providerVersion: node.provider.version ?? 0,
                      resourceType: node.resource.Type,
                      removalPolicy: "retain",
                      providerMode: node.mode,
                    },
            });
          }),
        })),
    );
    return prepared;
  });
