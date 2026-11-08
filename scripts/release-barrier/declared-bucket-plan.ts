import { prepareDeclaredD1 } from "./declared-d1-plan.ts";
import type { D1Provider, PreparedD1 } from "./declared-d1-types.ts";
import type * as Plan from "alchemy/Plan";
import { generateInstanceId } from "alchemy/InstanceId";
import { createPhysicalName } from "alchemy/PhysicalName";
import { State, isResourceState } from "alchemy/State/State";
import { Effect } from "effect";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import type { BucketTarget, PreparedBucket, BucketProvider } from "./declared-buckets.ts";
import { declaredBucketCreate } from "./declared-changes.ts";
import { declarationHistory } from "./declared-history.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { recordDeclaredReadiness, type DeclaredReadiness } from "./declared-prerequisites.ts";
import { declaredChecks } from "./declared-checks.ts";
import { havePropsChanged } from "alchemy/Diff";

export const prepareDeclaredBuckets = (
  plan: Plan.Plan,
  declarations: DeclaredChanges | undefined,
  stack: string,
  stage: string,
  provider: BucketProvider,
) =>
  Effect.gen(function* () {
    const prepared = new Map<string, PreparedBucket>();
    const state = yield* yield* State;
    const history = declarationHistory(yield* state.getOutput({ stack, stage }));
    if (declarations && declarations.stack !== stack)
      throw declaredMismatch(
        "declaration-stack-mismatch",
        "release-declarations.json",
        { stack },
        { stack: declarations.stack },
      );
    yield* declaredChecks(
      Object.entries(plan.resources)
        .filter(([, node]) => declaredBucketCreate(node, declarations))
        .map(([fqn, node]) => ({
          fqn,
          type: "Cloudflare.D1Database" as const,
          check: Effect.gen(function* () {
            const saved = history.buckets[fqn];
            const row = node.state;
            const persisted = yield* state.get({ stack, stage, fqn });
            if (
              (row && (!isResourceState(persisted) || persisted.status !== "creating")) ||
              (!row && persisted)
            )
              throw declaredMismatch("alchemy-state-drift", fqn, row ?? {}, persisted ?? {});
            if (row && isResourceState(persisted)) {
              const { attr: plannedObservation, ...plannedIdentity } = row;
              const { attr: persistedObservation, ...persistedIdentity } = persisted;
              if (
                havePropsChanged(plannedIdentity, persistedIdentity) ||
                persistedObservation !== undefined
              )
                throw declaredMismatch("alchemy-state-drift", fqn, plannedIdentity, {
                  ...persistedIdentity,
                  attr: persistedObservation,
                });
              if (
                plannedObservation &&
                saved &&
                (plannedObservation.accountId !== saved.target.accountId ||
                  plannedObservation.bucketName !== saved.target.bucketName ||
                  plannedObservation.jurisdiction !== "eu" ||
                  plannedObservation.storageClass !== "Standard")
              )
                throw declaredMismatch(
                  "declared-prerequisite-identity-mismatch",
                  fqn,
                  saved.target,
                  plannedObservation,
                );
            }
            if (row && row.status !== "creating")
              throw declaredMismatch(
                "declared-prerequisite-identity-mismatch",
                fqn,
                { status: "creating" },
                { status: row.status },
              );
            if (!row && saved)
              throw declaredMismatch(
                "declared-resource-history-without-state",
                fqn,
                { nativeRow: "present" },
                { nativeRow: null },
              );
            if (row && (!saved || saved.status !== "acknowledged"))
              throw declaredMismatch(
                "declared-bucket-outcome-unknown",
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
                  "Provision this bucket in a separate admitted release before adding its binding.",
                ],
              });
            const accountId = yield* Effect.promise(provider.accountId);
            const instanceId = row?.instanceId ?? (yield* generateInstanceId());
            const bucketName =
              saved?.target.bucketName ??
              (yield* createPhysicalName({
                id: node.resource.LogicalId,
                instanceId,
                maxLength: 63,
              })).toLowerCase();
            const target: BucketTarget = {
              accountId,
              bucketName,
              jurisdiction: "eu",
              storageClass: "Standard",
            };
            const entry = digest(
              canonical(declarations!.changes.find((entry) => entry.fqn === fqn)),
            );
            if (
              row &&
              (!saved ||
                saved.entry !== entry ||
                saved.instanceId !== instanceId ||
                saved.providerVersion !== (node.provider.version ?? 0) ||
                canonical(saved.target) !== canonical(target) ||
                row.providerVersion !== saved.providerVersion ||
                row.providerMode !== node.mode ||
                row.logicalId !== node.resource.LogicalId)
            )
              throw declaredMismatch(
                "declared-prerequisite-identity-mismatch",
                fqn,
                {
                  entry,
                  instanceId,
                  providerVersion: node.provider.version ?? 0,
                  nativeProviderVersion: node.provider.version ?? 0,
                  target,
                  providerMode: node.mode,
                  logicalId: node.resource.LogicalId,
                },
                {
                  entry: saved?.entry,
                  instanceId: saved?.instanceId,
                  providerVersion: saved?.providerVersion,
                  nativeProviderVersion: row.providerVersion,
                  target: saved?.target,
                  providerMode: row.providerMode,
                  logicalId: row.logicalId,
                },
              );
            prepared.set(fqn, {
              fqn,
              declaration: digest(canonical(declarations)),
              entry,
              target,
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

/** Plan hydration is an observation; only the persisted acknowledged checkpoint owns an interrupted create. */
export const prepareDeclaredStorage = (
  evaluatedPlan: Plan.Plan,
  declarations: DeclaredChanges | undefined,
  scope: { stack: string; stage: string },
  provider: BucketProvider,
  record?: (value: DeclaredReadiness) => Promise<void>,
  d1?: D1Provider,
) =>
  Effect.gen(function* () {
    let buckets = new Map<string, PreparedBucket>();
    let databases = new Map<string, PreparedD1>();
    yield* declaredChecks([
      ...(d1
        ? [
            {
              fqn: "(declared D1)",
              type: "Cloudflare.D1Database" as const,
              check: prepareDeclaredD1(evaluatedPlan, declarations, scope, d1).pipe(
                Effect.tap((value) =>
                  Effect.sync(() => {
                    databases = value;
                  }),
                ),
                Effect.asVoid,
              ),
            },
          ]
        : []),
      {
        fqn: "(declared storage)",
        check: prepareDeclaredBuckets(
          evaluatedPlan,
          declarations,
          scope.stack,
          scope.stage,
          provider,
        ).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              buckets = value;
            }),
          ),
          Effect.asVoid,
        ),
      },
      {
        fqn: "(declared storage)",
        check: recordDeclaredReadiness(
          evaluatedPlan,
          declarations,
          scope,
          provider,
          "before-upload",
          record,
          d1,
        ).pipe(Effect.asVoid),
      },
    ]);
    const storage = new Map<string, PreparedBucket | PreparedD1>([...buckets, ...databases]);
    const plan = {
      ...evaluatedPlan,
      resources: Object.fromEntries(
        Object.entries(evaluatedPlan.resources).map(([fqn, node]) => [
          fqn,
          storage.get(fqn)?.resume && node.action === "create"
            ? { ...node, state: storage.get(fqn)!.native }
            : node,
        ]),
      ),
    };
    return { plan, buckets, databases };
  });
