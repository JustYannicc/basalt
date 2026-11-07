import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { temporaryProofDirectory } from "./proof-directory.ts";

test("a successful proof removes its temporary private fixture after the scope closes", async () => {
  const directory = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryProofDirectory("basalt-proof-success-");
        yield* Effect.promise(() => writeFile(join(directory, "fixture.json"), "{}"));
        assert.equal(existsSync(directory), true);
        return directory;
      }),
    ),
  );
  assert.equal(existsSync(directory), false);
});

test("a failed proof retains its diagnostic fixture for recovery", async (t) => {
  let directory: string | undefined;
  t.after(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          directory = yield* temporaryProofDirectory("basalt-proof-failure-");
          yield* Effect.promise(() => writeFile(join(directory!, "failure.log"), "first failure"));
          return yield* Effect.fail(new Error("Proof failed"));
        }),
      ),
    ),
    /Proof failed/,
  );
  assert.ok(directory);
  assert.equal(existsSync(join(directory, "failure.log")), true);
});
