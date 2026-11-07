import type * as Plan from "alchemy/Plan";
import * as Apply from "alchemy/Apply";
import { generateInstanceId } from "alchemy/InstanceId";
import { createPhysicalName } from "alchemy/PhysicalName";
import { State } from "alchemy/State/State";
import type { CreatingResourceState } from "alchemy/State/ResourceState";
import type { Bucket } from "alchemy/Cloudflare/R2";
import { Effect, Cause } from "effect";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import { havePropsChanged } from "alchemy/Diff";
import { declaredBucketCreate } from "./declared-changes.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";
import { bucketFailure, bucketRead } from "./bucket-failure.ts";
import { declarationHistory, recordBucketHistory } from "./declared-history.ts";

export interface BucketTarget {
  accountId: string;
  bucketName: string;
  jurisdiction: "eu";
  storageClass: "Standard";
}
export interface BucketObservation {
  attributes: Bucket["Attributes"];
  publicAccess: boolean;
}
export interface BucketProvider {
  accountId(): Promise<string>;
  read(target: BucketTarget, fqn: string): Promise<BucketObservation | undefined>;
  create(target: BucketTarget): Promise<void>;
  configure(target: BucketTarget): Promise<void>;
}
export interface PreparedBucket {
  fqn: string;
  declaration: string;
  entry: string;
  target: BucketTarget;
  native: CreatingResourceState;
  initialLifecycle: "absent" | "creating";
  resume: boolean;
}
export interface BucketProgress {
  bucket: PreparedBucket;
  lifecycle: "planned" | "creating" | "created";
  outcome: "not-started" | "pending" | "acknowledged" | "confirmed" | "unknown";
}

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
      throw new BarrierRefusal("declaration-stack-mismatch");
    for (const [fqn, node] of Object.entries(plan.resources)) {
      if (!declaredBucketCreate(node, declarations)) continue;
      const saved = history.buckets[fqn];
      const row = node.state;
      if (row && row.status !== "creating")
        throw new BarrierRefusal("declared-prerequisite-identity-mismatch", fqn);
      if (!row && saved) throw new BarrierRefusal("declared-resource-history-without-state", fqn);
      if (row && (!saved || saved.status !== "acknowledged"))
        throw new BarrierRefusal("declared-bucket-outcome-unknown", fqn);
      if (node.downstream.length)
        throw new BarrierRefusal("declared-prerequisite-missing", fqn, {
          fqn,
          type: node.resource.Type,
          changed: [{ path: "$resource", old: null, new: "required-by-candidate" }],
          why: ["Provision this bucket in a separate admitted release before adding its binding."],
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
      const entry = digest(canonical(declarations!.changes.find((entry) => entry.fqn === fqn)));
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
        throw new BarrierRefusal("declared-prerequisite-identity-mismatch", fqn);
      prepared.set(fqn, {
        fqn,
        declaration: digest(canonical(declarations)),
        entry,
        target,
        resume: row !== undefined,
        initialLifecycle: row ? "creating" : "absent",
        native: row
          ? structuredClone(row)
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
    }
    return prepared;
  });

export function assertBucketObservation(
  bucket: Pick<PreparedBucket, "fqn" | "target">,
  observation: BucketObservation | undefined,
) {
  const attr = observation?.attributes;
  if (!attr)
    throw new BarrierRefusal("declared-bucket-observation-mismatch", bucket.fqn, {
      fqn: bucket.fqn,
      type: "Cloudflare.R2.Bucket",
      changed: [{ path: "$resource", old: "created", new: null }],
    });
  const expected = {
    account: digest(bucket.target.accountId),
    name: digest(bucket.target.bucketName),
    jurisdiction: "eu",
    storageClass: "Standard",
    publicAccess: false,
    publicDomain: false,
    domainCount: 0,
    corsCount: 0,
    lifecycleRuleCount: 0,
  };
  const actual = {
    account: digest(attr.accountId),
    name: digest(attr.bucketName),
    jurisdiction: attr.jurisdiction,
    storageClass: attr.storageClass,
    publicAccess: observation.publicAccess,
    publicDomain: attr.publicDomain !== undefined,
    domainCount: attr.domains.length,
    corsCount: attr.cors.length,
    lifecycleRuleCount: attr.lifecycleRules.length,
  };
  const changed = changedProps(expected, actual);
  if (changed.length)
    throw new BarrierRefusal("declared-bucket-observation-mismatch", bucket.fqn, {
      fqn: bucket.fqn,
      type: "Cloudflare.R2.Bucket",
      changed,
    });
  return attr;
}

export const createDeclaredBuckets = (
  plan: Plan.Plan,
  buckets: ReadonlyMap<string, PreparedBucket>,
  scope: { stack: string; stage: string },
  provider: BucketProvider,
  candidate: string,
  record: (progress: BucketProgress) => Promise<void>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    for (const [fqn, bucket] of buckets) {
      const current = yield* state.get({ ...scope, fqn });
      if (havePropsChanged(current ?? {}, bucket.resume ? bucket.native : {}))
        throw new BarrierRefusal("alchemy-state-drift", fqn, {
          fqn,
          type: "Cloudflare.R2.Bucket",
          changed: changedProps(bucket.resume ? bucket.native : {}, current ?? {}),
        });
      const saved = declarationHistory(yield* state.getOutput(scope)).buckets[fqn];
      if (
        (!bucket.resume && saved) ||
        (bucket.resume &&
          (!saved ||
            saved.status !== "acknowledged" ||
            saved.entry !== bucket.entry ||
            saved.instanceId !== bucket.native.instanceId ||
            canonical(saved.target) !== canonical(bucket.target)))
      )
        throw new BarrierRefusal("declared-prerequisite-identity-mismatch", fqn);
      if (bucket.target.accountId !== (yield* Effect.promise(provider.accountId)))
        throw new BarrierRefusal("declared-bucket-account-drift", fqn);
      if (
        !bucket.resume &&
        (yield* Effect.promise(() => bucketRead(fqn, () => provider.read(bucket.target, fqn))))
      )
        throw new BarrierRefusal("declared-bucket-name-collision", fqn);
      let acknowledged = bucket.resume;
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          if (!bucket.resume) {
            yield* state.set({ ...scope, fqn, value: bucket.native });
            yield* recordBucketHistory(scope, bucket, candidate, "pending");
            yield* Effect.promise(() =>
              record({ bucket, lifecycle: "creating", outcome: "pending" }),
            );
            yield* Effect.promise(() => provider.create(bucket.target));
            acknowledged = true;
            yield* recordBucketHistory(scope, bucket, candidate, "acknowledged");
            yield* Effect.promise(() =>
              record({ bucket, lifecycle: "creating", outcome: "acknowledged" }),
            );
            yield* Effect.promise(() => provider.configure(bucket.target));
          }
          const attributes = assertBucketObservation(
            bucket,
            yield* Effect.promise(() => bucketRead(fqn, () => provider.read(bucket.target, fqn))),
          );
          const node = plan.resources[fqn]!;
          yield* Apply.apply({
            ...plan,
            selectedFqns: new Set([fqn]),
            output: undefined,
            actions: {},
            deletions: {},
            actionDeletions: {},
            resources: {
              [fqn]: {
                ...node,
                action: "create",
                props: bucket.native.props,
                state: bucket.native,
                provider: {
                  ...node.provider,
                  precreate: undefined,
                  reconcile: (input) =>
                    Effect.sync(() => {
                      if (havePropsChanged(input.news, bucket.native.props))
                        throw new BarrierRefusal("declared-bucket-input-drift", fqn);
                      return attributes;
                    }),
                },
              },
            },
          });
          yield* recordBucketHistory(scope, bucket, candidate, "created");
        }),
      );
      if (result._tag === "Failure") {
        const row = yield* state.get({ ...scope, fqn });
        const lifecycle =
          row?.status === "created" || row?.status === "updated" ? "created" : "creating";
        yield* Effect.promise(() =>
          record({ bucket, lifecycle, outcome: acknowledged ? "acknowledged" : "unknown" }),
        );
        const cause = Cause.squash(result.cause);
        if (cause instanceof BarrierRefusal) throw cause;
        throw bucketFailure(
          cause,
          fqn,
          acknowledged ? "configure-bucket" : "create-bucket",
          "declared-bucket-creation-unconfirmed",
        );
      }
      yield* Effect.promise(() => record({ bucket, lifecycle: "created", outcome: "confirmed" }));
    }
  });
