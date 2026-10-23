import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";

// Load the prepared dependency at runtime without adding its source graph to Basalt's typecheck.
const { encryptedWorkflowTask, workflowResults } = await import(
  new URL("../../.upstream/apps/hosted/cloud/src/infrastructure/workflow-results.ts", import.meta.url).href
);
const { WorkflowStep } = await import(
  new URL("../../node_modules/alchemy/lib/Cloudflare/Workflows/WorkflowRuntime.js", import.meta.url).href
);

test("parallel branch completion order does not rerun cached workflow steps", async () => {
  const journal = new Map<string, Uint8Array>();
  const executed: string[] = [];
  let firstCompleted: string | undefined;
  const step = {
    do: ({ name, effect }: { name: string; effect: Effect.Effect<Uint8Array> }) =>
      Effect.suspend(() => {
        const cached = journal.get(name);
        return cached
          ? Effect.succeed(cached)
          : effect.pipe(Effect.tap((value) => Effect.sync(() => journal.set(name, value))));
      }),
  };

  const execute = () =>
    Effect.gen(function* () {
      const results = yield* workflowResults(
        "parallel-replay-fixture",
        Effect.succeed(Redacted.make("0".repeat(64))),
      );
      const task = (name: string, delay = 0) =>
        encryptedWorkflowTask({
          results,
          name,
          work: () =>
            Effect.sleep(delay).pipe(
              Effect.map(() => {
                executed.push(name);
                firstCompleted ??= name;
                return { name, content: "private-result-fixture" };
              }),
            ),
          encodeFailure: String,
          isRetryable: () => false,
          restoreFailure: (failure: { message: string }) => new Error(failure.message),
        });
      return yield* Effect.all(
        [
          task("A", 40).pipe(Effect.flatMap(() => task("C"))),
          task("B").pipe(Effect.flatMap(() => task("D"))),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provideService(WorkflowStep, step));

  const first = await Effect.runPromise(execute());
  assert.equal(firstCompleted, "B");
  assert.equal(executed.length, 4);
  const replay = await Effect.runPromise(execute());
  assert.deepEqual(replay, first);
  assert.equal(executed.length, 4, `cached replay reran ${executed.slice(4).join(", ")}`);
  assert.equal(journal.size, 4);
  for (const value of journal.values()) {
    assert.ok(value instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(value).includes("private-result-fixture"), false);
  }
});
