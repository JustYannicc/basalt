import type * as Plan from "alchemy/Plan";
import { State, isResourceState } from "alchemy/State/State";
import { Cause, Effect } from "effect";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import { bucketRead } from "./bucket-failure.ts";
import { declarationHistory } from "./declared-history.ts";
import { assertBucketObservation, type BucketProvider } from "./declared-buckets.ts";
import { changedProps } from "./prop-diff.ts";
import { bucketIntentMatches } from "./declared-changes.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";

export interface DeclaredPrerequisite {
  fqn: string;
  type: "Cloudflare.R2.Bucket";
  entry: string;
  ready: boolean;
  lifecycle: "absent" | "creating" | "created" | "updated" | "unknown";
  target?: string;
  identity?: string;
  observation?: string;
}
export interface DeclaredReadiness {
  declaration: string;
  phase: "before-upload" | "before-activation";
  resources: DeclaredPrerequisite[];
  failure?: { reason: string; resource?: string };
}

/** A retained declaration proves intent; readiness requires the current native row and a fresh provider observation. */
export const observeDeclaredPrerequisites = (
  plan: Plan.Plan,
  declarations: DeclaredChanges | undefined,
  scope: { stack: string; stage: string },
  provider: BucketProvider,
  phase: DeclaredReadiness["phase"],
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const history = declarationHistory(yield* state.getOutput(scope));
    const resources: DeclaredPrerequisite[] = [];
    for (const fqn of Object.keys(history.buckets))
      if (
        !declarations?.changes.some(
          (entry) => entry.action === "create-bucket" && entry.fqn === fqn,
        )
      )
        throw new BarrierRefusal("declared-resource-declaration-removed", fqn);
    for (const entry of declarations?.changes ?? []) {
      if (entry.action !== "create-bucket") continue;
      const node = plan.resources[entry.fqn];
      const row = yield* state.get({ ...scope, fqn: entry.fqn });
      const saved = history.buckets[entry.fqn];
      const entryDigest = digest(canonical(entry));
      if (!row && !saved && node?.action === "create" && phase === "before-upload") {
        resources.push({
          fqn: entry.fqn,
          type: entry.type,
          entry: entryDigest,
          ready: false,
          lifecycle: "absent",
        });
        continue;
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
      const providerAccount = yield* Effect.promise(provider.accountId);
      if (
        !node ||
        !saved ||
        !["created", "acknowledged"].includes(saved.status) ||
        saved.entry !== entryDigest ||
        !bucketIntentMatches(node, entry) ||
        canonical(row.props) !== canonical(entry.props) ||
        row.instanceId !== saved.instanceId ||
        row.fqn !== entry.fqn ||
        row.resourceType !== entry.type ||
        row.logicalId !== node.resource.LogicalId ||
        row.removalPolicy !== "retain" ||
        row.providerVersion !== (node.provider.version ?? 0) ||
        row.providerMode !== node.mode ||
        (row.status !== "creating" &&
          (row.attr.accountId !== saved.target.accountId ||
            row.attr.bucketName !== saved.target.bucketName)) ||
        row.providerVersion !== saved.providerVersion ||
        saved.target.accountId !== providerAccount
      )
        throw new BarrierRefusal("declared-prerequisite-identity-mismatch", entry.fqn, {
          fqn: entry.fqn,
          type: entry.type,
          changed: changedProps(
            {
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
              history: "attributable-created-resource",
              environmentAccountId: saved?.target.accountId,
            },
            {
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
                      bucketName: row.attr.bucketName,
                    },
              environmentAccountId: providerAccount,
              history:
                saved && ["created", "acknowledged"].includes(saved.status)
                  ? "attributable-created-resource"
                  : null,
            },
          ),
        });
      const observed = yield* Effect.tryPromise({
        try: () => bucketRead(entry.fqn, () => provider.read(saved.target, entry.fqn)),
        catch: (error) => error,
      });
      if (!observed)
        throw new BarrierRefusal("declared-prerequisite-missing", entry.fqn, {
          fqn: entry.fqn,
          type: entry.type,
          changed: [{ path: "$resource", old: "created", new: null }],
        });
      assertBucketObservation({ fqn: entry.fqn, target: saved.target }, observed);
      resources.push({
        fqn: entry.fqn,
        type: entry.type,
        entry: entryDigest,
        ready: row.status !== "creating",
        lifecycle: row.status,
        target: digest(canonical(saved.target)),
        identity: digest(row.instanceId),
        observation: digest(canonical(observed)),
      });
    }
    return {
      declaration: digest(canonical(declarations ?? null)),
      phase,
      resources,
    } satisfies DeclaredReadiness;
  });

/** A failed fresh observation must replace an earlier ready receipt from this attempt. */
export const recordDeclaredReadiness = (
  plan: Plan.Plan,
  declarations: DeclaredChanges | undefined,
  scope: { stack: string; stage: string },
  provider: BucketProvider,
  phase: DeclaredReadiness["phase"],
  record?: (value: DeclaredReadiness) => Promise<void>,
) =>
  observeDeclaredPrerequisites(plan, declarations, scope, provider, phase).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (record) {
          const error = Cause.squash(cause);
          yield* Effect.promise(() =>
            record({
              declaration: digest(canonical(declarations ?? null)),
              phase,
              resources: (declarations?.changes ?? []).flatMap((entry) =>
                entry.action === "create-bucket"
                  ? [
                      {
                        fqn: entry.fqn,
                        type: entry.type,
                        entry: digest(canonical(entry)),
                        ready: false,
                        lifecycle: "unknown",
                      },
                    ]
                  : [],
              ),
              failure: {
                reason:
                  error instanceof BarrierRefusal
                    ? error.reason
                    : "declared-prerequisite-observation-failed",
                ...(error instanceof BarrierRefusal && error.worker
                  ? { resource: error.worker }
                  : {}),
              },
            }),
          );
        }
        return yield* Effect.failCause(cause);
      }),
    ),
    Effect.tap((value) => (record ? Effect.promise(() => record(value)) : Effect.void)),
  );
