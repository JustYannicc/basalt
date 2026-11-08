import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Schema } from "effect";
import { containerKey, journalKey } from "./forward-journal.ts";
import { encodedRecordHash, recordedContainer } from "./forward-model.ts";

const journalHeader = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  complete: Schema.Boolean,
});

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
      journal: journal === undefined ? null : Schema.decodeUnknownSync(journalHeader)(journal),
    };
  });

export type ForwardStateObservation = Effect.Success<
  ReturnType<typeof readForwardStateObservation>
>;
