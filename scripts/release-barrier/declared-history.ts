import { State } from "alchemy/State/State";
import { Effect, Schema, SchemaIssue } from "effect";
import type { PreparedBucket } from "./declared-buckets.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { publicPropPath } from "./prop-diff.ts";
import { BarrierRefusal, canonical } from "./manifest.ts";

const issuePaths = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "invalid",
  checkHook: () => "invalid",
});
export const declarationHistoryKey = "$basaltDeclaredChanges";
const key = declarationHistoryKey;
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const databaseHistory = Schema.Struct({
  entry: hash,
  declaration: hash,
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  instanceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  target: Schema.Struct({
    accountId: Schema.NonEmptyString,
    databaseName: Schema.NonEmptyString,
    jurisdiction: Schema.Literal("eu"),
  }),
  databaseId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u))),
  status: Schema.Literals(["pending", "acknowledged", "created"]),
  providerVersion: Schema.Number,
});
const history = Schema.Struct({
  databases: Schema.optionalKey(Schema.Record(Schema.String, databaseHistory)),
  schemaVersion: Schema.Literal(1),
  buckets: Schema.Record(
    Schema.String,
    Schema.Struct({
      entry: hash,
      declaration: hash,
      candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
      instanceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
      target: Schema.Struct({
        accountId: Schema.NonEmptyString,
        bucketName: Schema.NonEmptyString,
        jurisdiction: Schema.Literal("eu"),
        storageClass: Schema.Literal("Standard"),
      }),
      status: Schema.Literals(["pending", "acknowledged", "created"]),
      providerVersion: Schema.Number,
    }),
  ),
});
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function declarationHistory(output: unknown) {
  if (!object(output) || !Object.hasOwn(output, key))
    return { schemaVersion: 1 as const, buckets: {}, databases: {} } satisfies typeof history.Type;
  try {
    const saved = Schema.decodeUnknownSync(history, { onExcessProperty: "error" })(output[key]);
    return { ...saved, databases: saved.databases ?? {} };
  } catch (error) {
    throw new BarrierRefusal("declared-history-invalid", "$basaltDeclaredChanges", {
      fqn: "$basaltDeclaredChanges",
      type: "Alchemy.DeclaredChanges",
      changed: Schema.isSchemaError(error)
        ? issuePaths(error.issue).issues.map((issue) => ({
            path: publicPropPath(
              (issue.path ?? []).map((part) => String(typeof part === "object" ? part.key : part)),
            ),
            changed: true,
          }))
        : [{ path: "$history", changed: true }],
    });
  }
}

export const recordBucketHistory = (
  scope: { stack: string; stage: string },
  bucket: PreparedBucket,
  candidate: string,
  status: "pending" | "acknowledged" | "created",
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const output = yield* state.getOutput(scope);
    if (output !== undefined && !object(output))
      throw declaredMismatch(
        "declared-history-output-unsupported",
        "$basaltDeclaredChanges",
        { outputType: "object" },
        { outputType: typeof output },
      );
    const previous = declarationHistory(output);
    const existing = previous.buckets[bucket.fqn];
    if (
      existing &&
      (existing.instanceId !== bucket.native.instanceId ||
        existing.entry !== bucket.entry ||
        existing.providerVersion !== bucket.native.providerVersion ||
        canonical(existing.target) !== canonical(bucket.target))
    )
      throw declaredMismatch(
        "declared-history-identity-drift",
        bucket.fqn,
        {
          instanceId: existing.instanceId,
          entry: existing.entry,
          providerVersion: existing.providerVersion,
          target: existing.target,
        },
        {
          instanceId: bucket.native.instanceId,
          entry: bucket.entry,
          providerVersion: bucket.native.providerVersion,
          target: bucket.target,
        },
      );
    yield* state.setOutput({
      ...scope,
      value: {
        ...output,
        [key]: {
          ...previous,
          schemaVersion: 1,
          buckets: {
            ...previous.buckets,
            [bucket.fqn]: {
              entry: bucket.entry,
              declaration: existing?.declaration ?? bucket.declaration,
              candidate: existing?.candidate ?? candidate,
              providerVersion: bucket.native.providerVersion,
              instanceId: bucket.native.instanceId,
              target: bucket.target,
              status,
            },
          },
        },
      },
    });
  });

/** Native Apply replaces stack outputs. The creation journal must survive that replacement. */
export const preserveDeclarationHistory = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  scope: { stack: string; stage: string },
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const output = yield* state.getOutput(scope);
    if (!object(output) || !Object.hasOwn(output, key)) return yield* effect;
    const saved = declarationHistory(output);
    return yield* effect.pipe(
      Effect.provideService(
        State,
        Effect.succeed({
          ...state,
          setOutput: (input) => {
            if (input.stack !== scope.stack || input.stage !== scope.stage)
              return state.setOutput(input);
            if (!object(input.value))
              return Effect.die(
                declaredMismatch(
                  "declared-history-output-unsupported",
                  "$basaltDeclaredChanges",
                  { outputType: "object" },
                  { outputType: typeof input.value },
                ),
              );
            return state.setOutput({ ...input, value: { ...input.value, [key]: saved } });
          },
        }),
      ),
    );
  });
