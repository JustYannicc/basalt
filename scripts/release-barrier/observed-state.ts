import { State, type StateService, type StateStoreError } from "alchemy/State/State";
import { Effect } from "effect";
import { ReleaseStateStoreFailure, type ReleaseOperation } from "./operation-failure.ts";

/** State calls inside Alchemy bypass providers, so observe their own resource keys. */
export function observedState(
  state: StateService,
  read: ReleaseOperation,
  write: ReleaseOperation,
): StateService {
  const observe = (resource: string, operation: ReleaseOperation) =>
    Effect.mapError(
      (error: StateStoreError) => new ReleaseStateStoreFailure(error, resource, operation),
    );
  return {
    ...state,
    get: (input) => state.get(input).pipe(observe(input.fqn, read)),
    set: (input) => state.set(input).pipe(observe(input.fqn, write)),
    list: (input) => state.list(input).pipe(observe(`${input.stack}/${input.stage}`, read)),
    getReplacedResources: (input) =>
      state.getReplacedResources(input).pipe(observe(`${input.stack}/${input.stage}`, read)),
    getOutput: (input) => state.getOutput(input).pipe(observe(`${input.stack}/output`, read)),
    setOutput: (input) => state.setOutput(input).pipe(observe(`${input.stack}/output`, write)),
  };
}

export const withStateOperations =
  (read: ReleaseOperation, write: ReleaseOperation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* effect.pipe(
        Effect.provideService(State, Effect.succeed(observedState(state, read, write))),
      );
    });
