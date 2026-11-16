import { Schema } from "effect";

const identity = { candidate: Schema.String, manifest: Schema.String, complete: Schema.Boolean };
const JournalObservation = Schema.Union([
  Schema.Struct({ schemaVersion: Schema.Literal(1), ...identity }),
  Schema.Struct({
    schemaVersion: Schema.Literal(2),
    kind: Schema.Literal("runtime-provisioning"),
    ...identity,
  }),
]);

/** Payload authentication belongs to the journal reader; this projection never exposes sealed state. */
export const observeJournalHeader = Schema.decodeUnknownSync(JournalObservation);
