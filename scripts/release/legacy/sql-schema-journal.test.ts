import assert from "node:assert/strict";
import { test } from "node:test";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect } from "effect";
import { canonical, digest } from "../../pool-fleet/manifest.ts";
import { sealRecovery } from "../../pool-history/recovery-envelope.ts";
import { readySqlSchemas } from "../sql-schema-fixture.ts";
import { readSqlSchemaJournal } from "./sql-schema-journal.ts";

const stack = { name: "basalt", stage: "production" };
const key = "f".repeat(64);
const candidate = "c".repeat(40);

/** The value the old layer's writer stored, sealed the same way. */
function journal(unresolvedHome: unknown, fingerprintCandidate = candidate) {
  const receipt = readySqlSchemas(candidate);
  const fingerprint = digest(
    canonical({ candidate: fingerprintCandidate, homeImageDigest: receipt.homeImageDigest }),
  );
  return {
    schemaVersion: 1,
    candidate,
    fingerprint,
    sealed: sealRecovery({ receipt, unresolvedHome }, key, candidate, fingerprint),
  };
}

const read = (value: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      if (value !== undefined)
        yield* state.setOutput({ stack: "basalt-sql-schema-barrier", stage: "production", value });
      return yield* readSqlSchemaJournal(stack, key).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      );
    }),
  );

test("a missing journal reads as undefined", async () => {
  assert.equal(await read(undefined), undefined);
});

test("a settled journal opens with a null unresolvedHome", async () => {
  const opened = await read(journal(null));
  assert.equal(opened?.unresolvedHome, null);
  assert.equal(opened?.receipt.candidate, candidate);
});

test("a journal whose fingerprint names another candidate is refused", async () => {
  await assert.rejects(read(journal(null, "d".repeat(40))), /sql-schema-journal-mismatch/u);
});
