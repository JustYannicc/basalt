import { Data, Effect } from "effect";
import * as Interaction from "alchemy/Interaction";

export class StateStoreBootstrapPossible extends Data.TaggedError("StateStoreBootstrapPossible")<{
  readonly why: string;
  readonly fix: string;
}> {}

/**
 * Every State store bootstrap or upgrade path in alchemy beta.80 needs `updateStateStore` or an
 * answered confirm prompt (Cloudflare/StateStore/State.ts:104-125, 152-178, 228-238). The release
 * entry always passes `updateStateStore: false`; this proves the prompt cannot be answered either,
 * so a store that does not answer stops the run instead of being redeployed with a new token.
 */
export const storeCannotBootstrap = Effect.gen(function* () {
  const answered = yield* Interaction.accessors.prompt
    .confirm({ message: "Deploy the Cloudflare State store?", initialValue: true })
    .pipe(
      Effect.map(() => true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
  if (answered)
    return yield* new StateStoreBootstrapPossible({
      why: "A State store confirm prompt was answered in the release process.",
      fix: "Run releases with Alchemy's non-interactive layer only.",
    });
});
