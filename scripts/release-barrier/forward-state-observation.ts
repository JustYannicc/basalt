import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect } from "effect";
import { observeJournalHeader } from "./journal-observation.ts";
import { containerKey, journalKey } from "./forward-journal.ts";
import { encodedRecordHash, recordedContainer } from "./forward-model.ts";

/** Observe exact resource bytes and the public journal header without retaining encrypted payloads. */
export const readForwardStateObservation = (
  state: Pick<StateService, "getVersion" | "get" | "getOutput">,
  stack: Pick<CompiledStack, "name" | "stage">,
) =>
  Effect.gen(function* () {
    const nativeSchemaVersion = yield* state.getVersion();
    const saved = yield* state.get(containerKey(stack));
    const { saved: record, identity } = recordedContainer(saved);
    const journal = yield* state.getOutput(journalKey(stack));
    return {
      nativeSchemaVersion,
      resource: {
        recordFormat: "alchemy-resource" as const,
        status: record.status,
        hash: encodedRecordHash(saved),
        version: identity.version,
      },
      journal: journal === undefined ? null : observeJournalHeader(journal),
    };
  });

export type ForwardStateObservation = Effect.Success<
  ReturnType<typeof readForwardStateObservation>
>;
