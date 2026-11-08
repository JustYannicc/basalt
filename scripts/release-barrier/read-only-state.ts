import { Context, Effect, Layer, Option } from "effect";
import type { StackServices } from "alchemy/Stack";
import { State, type StateService } from "alchemy/State/State";
import {
  makeReadOnlyHttpStateStore,
  type ReadOnlyHttpStateStoreProps,
} from "alchemy/State/ReadOnlyHttpStateStore";

export class ReadOnlyPlanState extends Context.Service<
  ReadOnlyPlanState,
  { readonly state: StateService; readonly stack: string; readonly stage: string }
>()("basalt/ReadOnlyPlanState") {}

/** Choose before building the fallback layer so preflight cannot enter Cloudflare.state bootstrap. */
export const releaseStackState = (fallback: Layer.Layer<State, never, StackServices>) =>
  Layer.unwrap(
    Effect.serviceOption(ReadOnlyPlanState).pipe(
      Effect.map((selected) =>
        Option.isSome(selected)
          ? Layer.succeed(State, Effect.succeed(selected.value.state))
          : fallback,
      ),
    ),
  );

export const withReadOnlyPlanState =
  (options: ReadOnlyHttpStateStoreProps) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    makeReadOnlyHttpStateStore(options).pipe(
      Effect.flatMap((state) =>
        effect.pipe(
          Effect.provideService(ReadOnlyPlanState, {
            state,
            stack: options.stack,
            stage: options.stage,
          }),
        ),
      ),
    );
