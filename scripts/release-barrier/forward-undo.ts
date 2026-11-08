import { readFile, writeFile } from "node:fs/promises";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Config, Effect, Redacted, Schema } from "effect";
import { openRecovery } from "./recovery-envelope.ts";
import { containerKey } from "./forward-journal.ts";
import { undoForwardRecord } from "./forward-write.ts";

export const undoForwardAdoption = (stack: CompiledStack, path: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const key = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY");
    const sealed: unknown = JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")));
    const identity = Schema.decodeUnknownSync(
      Schema.Struct({ candidate: Schema.String, manifest: Schema.String }),
    )(sealed);
    const backup = openRecovery(sealed, Redacted.value(key), identity.candidate, identity.manifest);
    const context = yield* Effect.context<never>();
    const receipt = yield* Effect.tryPromise({
      try: () =>
        undoForwardRecord(backup, {
          read: () =>
            Effect.runPromise(state.get(containerKey(stack)).pipe(Effect.provideContext(context))),
          write: (value) =>
            Effect.runPromise(
              state
                .set({ ...containerKey(stack), value })
                .pipe(Effect.asVoid, Effect.provideContext(context)),
            ),
        }),
      catch: (error) => error,
    });
    yield* Effect.promise(() =>
      writeFile(`${path}.undo-receipt.json`, JSON.stringify(receipt), { mode: 0o600 }),
    );
    return receipt;
  });
