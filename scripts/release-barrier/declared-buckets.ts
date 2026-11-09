import type * as Plan from "alchemy/Plan";
import * as Apply from "alchemy/Apply";
import { State } from "alchemy/State/State";
import type { CreatingResourceState } from "alchemy/State/ResourceState";
import type { Bucket } from "alchemy/Cloudflare/R2";
import { Effect, Cause } from "effect";
import { havePropsChanged } from "alchemy/Diff";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { bucketFailure, bucketRead, type BucketOperation } from "./bucket-failure.ts";
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
        throw declaredMismatch(
          "declared-prerequisite-identity-mismatch",
          fqn,
          {
            status: bucket.resume ? "acknowledged" : null,
            entry: bucket.resume ? bucket.entry : null,
            instanceId: bucket.resume ? bucket.native.instanceId : null,
            target: bucket.resume ? bucket.target : null,
          },
          {
            status: saved?.status ?? null,
            entry: saved?.entry ?? null,
            instanceId: saved?.instanceId ?? null,
            target: saved?.target ?? null,
          },
        );
      const accountId = yield* Effect.promise(provider.accountId);
      if (bucket.target.accountId !== accountId)
        throw declaredMismatch(
          "declared-bucket-account-drift",
          fqn,
          { accountId: bucket.target.accountId },
          { accountId },
        );
      if (
        !bucket.resume &&
        (yield* Effect.promise(() => bucketRead(fqn, () => provider.read(bucket.target, fqn))))
      )
        throw declaredMismatch(
          "declared-bucket-name-collision",
          fqn,
          { resource: null },
          { resource: "exists" },
        );
      let acknowledged = bucket.resume;
      const phase: { operation: BucketOperation } = { operation: "commit-native-state" };
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          if (!bucket.resume) {
            yield* state.set({ ...scope, fqn, value: bucket.native });
            yield* recordBucketHistory(scope, bucket, candidate, "pending");
            phase.operation = "record-intent";
            yield* Effect.promise(() =>
              record({ bucket, lifecycle: "creating", outcome: "pending" }),
            );
            phase.operation = "create-bucket";
            yield* Effect.promise(() => provider.create(bucket.target));
            acknowledged = true;
            phase.operation = "commit-native-state";
            yield* recordBucketHistory(scope, bucket, candidate, "acknowledged");
            phase.operation = "record-intent";
            yield* Effect.promise(() =>
              record({ bucket, lifecycle: "creating", outcome: "acknowledged" }),
            );
            phase.operation = "configure-bucket";
            yield* Effect.promise(() => provider.configure(bucket.target));
          }
          phase.operation = "read-bucket";
          const attributes = assertBucketObservation(
            bucket,
            yield* Effect.promise(() => bucketRead(fqn, () => provider.read(bucket.target, fqn))),
          );
          const node = plan.resources[fqn]!;
          phase.operation = "commit-native-state";
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
                        throw declaredMismatch(
                          "declared-bucket-input-drift",
                          fqn,
                          bucket.native.props,
                          input.news,
                        );
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
        if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause);
        const cause = Cause.squash(result.cause);
        const failure = bucketFailure(
          cause,
          fqn,
          phase.operation,
          "declared-bucket-creation-unconfirmed",
        );
        if (phase.operation !== "record-intent") {
          const row = yield* state.get({ ...scope, fqn });
          const lifecycle =
            row?.status === "created" || row?.status === "updated" ? "created" : "creating";
          const reported = yield* Effect.exit(
            Effect.promise(() =>
              record({ bucket, lifecycle, outcome: acknowledged ? "acknowledged" : "unknown" }),
            ),
          );
          if (reported._tag === "Failure") {
            const recording = bucketFailure(Cause.squash(reported.cause), fqn, "record-intent");
            throw new BarrierRefusal(failure.reason, fqn, failure.delta, [
              ...(failure.refusals ?? [{ reason: failure.reason, ...failure.delta }]),
              { reason: recording.reason, ...recording.delta },
            ]);
          }
        }
        throw failure;
      }
      yield* Effect.tryPromise({
        try: () => record({ bucket, lifecycle: "created", outcome: "confirmed" }),
        catch: (error) => bucketFailure(error, fqn, "record-intent"),
      });
    }
  });
