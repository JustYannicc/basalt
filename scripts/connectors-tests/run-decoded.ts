import { Effect, Schema } from "effect";

/** An app operation or workflow as the tools harnesses evaluate it: its input schema and its run. */
interface Runnable<Context, Input> {
  readonly input: Schema.Codec<Input, unknown>;
  readonly run: (context: Context, input: Input) => Effect.Effect<unknown, unknown>;
}

/**
 * Decode raw input with the runnable's own schema, as the host does, then run it. Lives in
 * TypeScript so the harnesses' Effect calls are type-checked; the harnesses themselves stay
 * JavaScript and never name the effect package.
 */
export const runDecoded = async <Context, Input>(
  runnable: Runnable<Context, Input>,
  context: Context,
  input: unknown,
) => {
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(runnable.input)(input));
  return Effect.runPromise(runnable.run(context, decoded));
};
