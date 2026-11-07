import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";

export const temporaryProofDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (directory, exit) =>
      Exit.isSuccess(exit)
        ? Effect.promise(() => rm(directory, { recursive: true, force: true }))
        : Effect.sync(() => {
            console.error(`Proof failed; private diagnostics retained at ${directory}.`);
          }),
  );
