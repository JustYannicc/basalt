import type * as Plan from "alchemy/Plan";
import * as Apply from "alchemy/Apply";
import { State } from "alchemy/State/State";
import { havePropsChanged } from "alchemy/Diff";
import { Cause, Effect, Schema } from "effect";
import { BarrierRefusal, canonical } from "./manifest.ts";
import { declarationHistory } from "./declared-history.ts";
import { recordD1History } from "./declared-d1-history.ts";
import { assertD1Observation } from "./declared-d1-observation.ts";
import { databaseUuid } from "./d1-cloudflare.ts";
import {
  d1Mismatch,
  d1Failure,
  d1Read,
  type D1Provider,
  type PreparedD1,
  type D1Progress,
} from "./declared-d1-types.ts";
import { declaredChecks } from "./declared-checks.ts";
import type { BucketOperation } from "./bucket-failure.ts";

export const createDeclaredDatabases = (
  plan: Plan.Plan,
  databases: ReadonlyMap<string, PreparedD1>,
  scope: { stack: string; stage: string },
  provider: D1Provider,
  candidate: string,
  record: (progress: D1Progress) => Promise<void>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    yield* declaredChecks(
      [...databases]
        .filter(([, database]) => !database.resume)
        .map(([fqn, database]) => ({
          fqn,
          type: "Cloudflare.D1Database" as const,
          check: Effect.gen(function* () {
            if (yield* Effect.promise(() => d1Read(fqn, () => provider.exists(database.target))))
              throw d1Mismatch(
                "declared-d1-name-collision",
                fqn,
                { resource: null },
                { resource: "exists" },
              );
          }),
        })),
    );
    for (const [fqn, initial] of databases) {
      let database = initial;
      const current = yield* state.get({ ...scope, fqn });
      if (havePropsChanged(current ?? {}, database.resume ? database.native : {}))
        throw d1Mismatch(
          "alchemy-state-drift",
          fqn,
          database.resume ? database.native : {},
          current ?? {},
        );
      const saved = declarationHistory(yield* state.getOutput(scope)).databases[fqn];
      if (
        (!database.resume && saved) ||
        (database.resume &&
          (!saved ||
            saved.status !== "acknowledged" ||
            saved.entry !== database.entry ||
            saved.instanceId !== database.native.instanceId ||
            saved.databaseId !== database.databaseId ||
            canonical(saved.target) !== canonical(database.target)))
      )
        throw d1Mismatch(
          "declared-prerequisite-identity-mismatch",
          fqn,
          {
            status: database.resume ? "acknowledged" : null,
            entry: database.resume ? database.entry : null,
            target: database.resume ? database.target : null,
            databaseId: database.databaseId,
          },
          {
            status: saved?.status,
            entry: saved?.entry,
            target: saved?.target,
            databaseId: saved?.databaseId,
          },
        );
      const accountId = yield* Effect.promise(provider.accountId);
      if (accountId !== database.target.accountId)
        throw d1Mismatch(
          "declared-d1-account-drift",
          fqn,
          { accountId: database.target.accountId },
          { accountId },
        );
      if (
        !database.resume &&
        (yield* Effect.promise(() => d1Read(fqn, () => provider.exists(database.target))))
      )
        throw d1Mismatch(
          "declared-d1-name-collision",
          fqn,
          { resource: null },
          { resource: "exists" },
        );
      let acknowledged = database.resume;
      const phase: { operation: BucketOperation } = { operation: "commit-native-state" };
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          if (!database.resume) {
            yield* state.set({ ...scope, fqn, value: database.native });
            yield* recordD1History(scope, database, candidate, "pending");
            phase.operation = "record-intent";
            yield* Effect.promise(() =>
              record({ database, lifecycle: "creating", outcome: "pending" }),
            );
            phase.operation = "create-d1";
            const databaseId = Schema.decodeUnknownSync(databaseUuid)(
              yield* Effect.promise(() => provider.create(database.target)),
            );
            database = { ...database, databaseId };
            phase.operation = "commit-native-state";
            yield* recordD1History(scope, database, candidate, "acknowledged");
            acknowledged = true;
            phase.operation = "record-intent";
            yield* Effect.promise(() =>
              record({ database, lifecycle: "creating", outcome: "acknowledged" }),
            );
          }
          phase.operation = "read-d1";
          const attributes = assertD1Observation(
            database,
            yield* Effect.promise(() =>
              d1Read(fqn, () => provider.read(database.target, database.databaseId!, fqn)),
            ),
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
                props: database.native.props,
                state: database.native,
                provider: {
                  ...node.provider,
                  precreate: undefined,
                  reconcile: (input) =>
                    Effect.sync(() => {
                      if (havePropsChanged(input.news, database.native.props))
                        throw d1Mismatch(
                          "declared-d1-input-drift",
                          fqn,
                          database.native.props,
                          input.news,
                        );
                      return attributes;
                    }),
                },
              },
            },
          });
          yield* recordD1History(scope, database, candidate, "created");
        }),
      );
      if (result._tag === "Failure") {
        if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause);
        const failure = d1Failure(
          Cause.squash(result.cause),
          fqn,
          phase.operation,
          "declared-d1-creation-unconfirmed",
        );
        if (phase.operation !== "record-intent") {
          const row = yield* state.get({ ...scope, fqn });
          const lifecycle =
            row?.status === "created" || row?.status === "updated" ? "created" : "creating";
          const reported = yield* Effect.exit(
            Effect.promise(() =>
              record({ database, lifecycle, outcome: acknowledged ? "acknowledged" : "unknown" }),
            ),
          );
          if (reported._tag === "Failure") {
            const recording = d1Failure(Cause.squash(reported.cause), fqn, "record-intent");
            throw new BarrierRefusal(failure.reason, fqn, failure.delta, [
              ...(failure.refusals ?? [{ reason: failure.reason, ...failure.delta }]),
              { reason: recording.reason, ...recording.delta },
            ]);
          }
        }
        throw failure;
      }
      yield* Effect.tryPromise({
        try: () => record({ database, lifecycle: "created", outcome: "confirmed" }),
        catch: (error) => d1Failure(error, fqn, "record-intent"),
      });
    }
  });
