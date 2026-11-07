import * as Workers from "@distilled.cloud/cloudflare/workers";
import { State } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import { declaredMismatch } from "./declared-refusal.ts";
import { BarrierRefusal } from "./manifest.ts";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const classObservation = Schema.Struct({
  accountId: Schema.NonEmptyString,
  scriptName: Schema.NonEmptyString,
  versionId: Schema.NonEmptyString,
  migrationTag: Schema.NonEmptyString,
  settings: Schema.toType(Workers.GetScriptScriptAndVersionSettingResponse),
  previewUrlsEnabled: Schema.Boolean,
});
const record = Schema.Struct({
  entry: hash,
  declaration: hash,
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  native: Schema.Struct({
    instanceId: Schema.NonEmptyString,
    workerId: Schema.NonEmptyString,
    providerVersion: Schema.Number,
    mode: Schema.optional(Schema.String),
  }),
  baseline: classObservation,
  newTag: Schema.NonEmptyString,
  marker: Schema.NonEmptyString,
  content: hash,
  payload: hash,
  tags: Schema.Array(Schema.String),
  recovery: Schema.Struct({
    metadata: Schema.toType(Workers.PutScriptMetadata),
    mainModule: Schema.NonEmptyString,
    files: Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        type: Schema.NonEmptyString,
        base64: Schema.String,
      }),
    ),
  }),
  clone: Schema.Struct({
    request: Schema.toType(Workers.CreateBetaWorkerVersionRequest),
    payload: hash,
    versionId: Schema.optional(Schema.NonEmptyString),
    status: Schema.Literals(["pending", "ready", "removal-pending", "removed"]),
  }),
  status: Schema.Literals(["clone-pending", "clone-ready", "pending", "acknowledged", "ready"]),
  observed: Schema.optional(classObservation),
  startupTimeMs: Schema.optional(Schema.Number),
});
const history = Schema.Record(Schema.String, record);
export type ClassRecord = typeof record.Type;
const key = "$basaltDeclaredClasses";
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const classHistory = (value: unknown) => {
  if (!object(value) || !Object.hasOwn(value, key)) return {} satisfies typeof history.Type;
  try {
    return Schema.decodeUnknownSync(history, { onExcessProperty: "error" })(value[key]);
  } catch {
    throw new BarrierRefusal("declared-class-history-invalid", key);
  }
};

export const saveClassHistory = (
  scope: { stack: string; stage: string },
  fqn: string,
  value: ClassRecord,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const output = yield* state.getOutput(scope);
    if (output !== undefined && !object(output))
      throw declaredMismatch(
        "declared-history-output-unsupported",
        fqn,
        { outputType: "object" },
        { outputType: typeof output },
        "Cloudflare.Worker",
      );
    const saved = classHistory(output);
    yield* state.setOutput({ ...scope, value: { ...output, [key]: { ...saved, [fqn]: value } } });
  });

export const preserveClassHistory = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  scope: { stack: string; stage: string },
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const before = yield* state.getOutput(scope);
    if (!object(before) || !Object.hasOwn(before, key)) return yield* effect;
    const saved = classHistory(before);
    return yield* effect.pipe(
      Effect.provideService(
        State,
        Effect.succeed({
          ...state,
          setOutput: (input) =>
            input.stack === scope.stack && input.stage === scope.stage
              ? object(input.value)
                ? state.setOutput({ ...input, value: { ...input.value, [key]: saved } })
                : Effect.die(new BarrierRefusal("declared-history-output-unsupported", key))
              : state.setOutput(input),
        }),
      ),
    );
  });
