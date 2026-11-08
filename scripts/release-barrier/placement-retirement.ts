import type { StateService } from "alchemy/State/State";
import { Effect, Schema } from "effect";

const key = (stack: { name: string; stage: string }) => ({
  stack: `${stack.name}-placement-repair`,
  stage: stack.stage,
});
const schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  retired: Schema.Array(Schema.String),
});
export const retiredPlacements = (state: StateService, stack: { name: string; stage: string }) =>
  state
    .getOutput(key(stack))
    .pipe(
      Effect.map((value) =>
        value === undefined ? [] : Schema.decodeUnknownSync(schema)(value).retired,
      ),
    );

/** Record each completed repair independently, including when the rest of a release fails. */
export const retirePlacement = (
  state: StateService,
  stack: { name: string; stage: string },
  role: string,
) =>
  Effect.gen(function* () {
    const retired = yield* retiredPlacements(state, stack);
    yield* state.setOutput({
      ...key(stack),
      value: { schemaVersion: 1, retired: [...new Set([...retired, role])].sort() },
    });
  });
