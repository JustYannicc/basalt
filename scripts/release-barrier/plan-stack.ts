import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import type { CompiledStack } from "alchemy/Stack";
import { Context, Effect, Option } from "effect";
import { withOperation } from "./operation-failure.ts";

function observedProvider(provider: Provider.ProviderService): Provider.ProviderService {
  const read = provider.read;
  const diff = provider.diff;
  return {
    ...provider,
    ...(read
      ? {
          read: (input) =>
            Effect.suspend(() => read(input)).pipe(withOperation(input.fqn, "plan-read-resource")),
        }
      : {}),
    ...(diff
      ? {
          diff: (input) =>
            Effect.suspend(() => diff(input)).pipe(withOperation(input.fqn, "plan-diff-resource")),
        }
      : {}),
    ...(provider.modes
      ? {
          modes: {
            live: provider.modes.live.pipe(Effect.map(observedProvider)),
            local: provider.modes.local.pipe(Effect.map(observedProvider)),
          },
        }
      : {}),
  };
}

/** Keep the failing logical resource when Plan invokes a provider, without changing its lifecycle. */
export const planStack = (stack: CompiledStack) =>
  Effect.gen(function* () {
    let context = yield* Effect.context<never>();
    for (const type of new Set(Object.values(stack.resources).map((resource) => resource.Type))) {
      const provider = yield* Provider.tryFindProviderRegistrationByType(type);
      if (Option.isSome(provider))
        context = Context.add(
          context,
          Context.Service<Provider.Provider, Provider.ProviderService>()(type),
          observedProvider(provider.value),
        );
    }
    return yield* Plan.make(stack).pipe(Effect.provideContext(context));
  }).pipe(withOperation("(plan)", "plan-stack"));
