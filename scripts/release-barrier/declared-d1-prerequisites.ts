import type * as Plan from "alchemy/Plan";
import { State, isResourceState } from "alchemy/State/State";
import { Effect } from "effect";
import type { D1Declaration, DeclaredChanges } from "./declared-change-schema.ts";
import { declarationHistory } from "./declared-history.ts";
import { declaredChecks } from "./declared-checks.ts";
import { declaredIntentMatches } from "./declared-changes.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { d1Mismatch, d1Read, type D1Provider } from "./declared-d1-types.ts";
import { assertD1Observation } from "./declared-d1-observation.ts";
import type { DeclaredReadiness, DeclaredPrerequisite } from "./declared-prerequisites.ts";

export const observeD1Prerequisites = (
  plan: Plan.Plan,
  declarations: DeclaredChanges | undefined,
  scope: { stack: string; stage: string },
  provider: D1Provider,
  phase: DeclaredReadiness["phase"],
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const history = declarationHistory(yield* state.getOutput(scope));
    const resources: DeclaredPrerequisite[] = [];
    const missing = Object.keys(history.databases)
      .filter(
        (fqn) =>
          !declarations?.changes.some(
            (entry) => entry.action === "create-d1-database" && entry.fqn === fqn,
          ),
      )
      .map((fqn) => ({
        fqn,
        check: Effect.die(
          new BarrierRefusal("declared-resource-declaration-removed", fqn, {
            fqn,
            type: "Cloudflare.D1Database",
            changed: [{ path: "$declaration", old: "retained", new: null }],
          }),
        ),
      }));
    const check = (entry: D1Declaration) =>
      Effect.gen(function* () {
        const node = plan.resources[entry.fqn];
        const row = yield* state.get({ ...scope, fqn: entry.fqn });
        const saved = history.databases[entry.fqn];
        const entryDigest = digest(canonical(entry));
        if (!row && !saved && node?.action === "create" && phase === "before-upload") {
          resources.push({
            fqn: entry.fqn,
            type: entry.type,
            entry: entryDigest,
            ready: false,
            lifecycle: "absent",
          });
          return;
        }
        if (
          !isResourceState(row) ||
          (row.status !== "created" &&
            row.status !== "updated" &&
            !(
              row.status === "creating" &&
              phase === "before-upload" &&
              saved?.status === "acknowledged" &&
              node?.action === "create" &&
              !node.downstream.length
            ))
        )
          throw new BarrierRefusal("declared-prerequisite-identity-mismatch", entry.fqn, {
            fqn: entry.fqn,
            type: entry.type,
            changed: [
              {
                path: "$lifecycle",
                old: "created-or-updated-or-attributable-create",
                new: row?.status ?? null,
              },
            ],
          });
        const accountId = yield* Effect.promise(provider.accountId);
        const expected = {
          entry: entryDigest,
          instanceId: saved?.instanceId,
          fqn: entry.fqn,
          resourceType: entry.type,
          logicalId: node?.resource.LogicalId,
          removalPolicy: "retain",
          props: entry.props,
          providerVersion: node?.provider.version ?? 0,
          providerMode: node?.mode,
          savedProviderVersion: node?.provider.version ?? 0,
          target: saved?.target,
          databaseId: saved?.databaseId,
          environmentAccountId: saved?.target.accountId,
          history: "attributable-created-resource",
        };
        const actual = {
          entry: saved?.entry,
          instanceId: row.instanceId,
          fqn: row.fqn,
          resourceType: row.resourceType,
          logicalId: row.logicalId,
          removalPolicy: row.removalPolicy,
          props: row.props,
          providerVersion: row.providerVersion,
          providerMode: row.providerMode,
          savedProviderVersion: saved?.providerVersion,
          target:
            row.status === "creating"
              ? saved?.target
              : {
                  ...saved?.target,
                  accountId: row.attr.accountId,
                  databaseName: row.attr.databaseName,
                },
          databaseId: row.status === "creating" ? saved?.databaseId : row.attr.databaseId,
          environmentAccountId: accountId,
          history:
            saved && ["created", "acknowledged"].includes(saved.status)
              ? "attributable-created-resource"
              : null,
        };
        if (
          !node ||
          !saved ||
          !saved.databaseId ||
          !declaredIntentMatches(node, entry) ||
          canonical(expected) !== canonical(actual)
        )
          throw d1Mismatch("declared-prerequisite-identity-mismatch", entry.fqn, expected, actual);
        const observed = yield* Effect.tryPromise({
          try: () =>
            d1Read(entry.fqn, () => provider.read(saved.target, saved.databaseId!, entry.fqn)),
          catch: (error) => error,
        });
        assertD1Observation(
          { fqn: entry.fqn, target: saved.target, databaseId: saved.databaseId },
          observed,
        );
        resources.push({
          fqn: entry.fqn,
          type: entry.type,
          entry: entryDigest,
          ready: row.status !== "creating",
          lifecycle: row.status,
          target: digest(canonical({ ...saved.target, databaseId: saved.databaseId })),
          identity: digest(row.instanceId),
          observation: digest(canonical(observed)),
        });
      });
    yield* declaredChecks([
      ...missing,
      ...(declarations?.changes ?? []).flatMap((entry) =>
        entry.action === "create-d1-database"
          ? [{ fqn: entry.fqn, type: "Cloudflare.D1Database" as const, check: check(entry) }]
          : [],
      ),
    ]);
    return resources;
  });
