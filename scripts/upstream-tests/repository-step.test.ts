import assert from "node:assert/strict";
import { test } from "node:test";
import { Data, Effect, Logger } from "effect";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const { repositoryStepFailed } = await load(
  "apps/hosted/cloud/src/implementation/repository-step.ts",
);

class ArtifactsError extends Data.TaggedError("ArtifactsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
class RpcCallError extends Data.TaggedError("RpcCallError")<{ readonly cause: unknown }> {}

const logged = async (step: string, error: unknown) => {
  const messages: unknown[] = [];
  await Effect.runPromise(
    repositoryStepFailed(step)(error).pipe(
      Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))])),
    ),
  );
  return messages;
};

test("a failed repository step names its step and the error's class, never its message", async () => {
  assert.deepEqual(
    await logged(
      "coordinator-create",
      new ArtifactsError({ message: "SECRET", cause: { code: "NOT_FOUND", detail: "SECRET" } }),
    ),
    [
      [
        "Repository step failed",
        { step: "coordinator-create", error: "ArtifactsError", code: "NOT_FOUND" },
      ],
    ],
  );
  assert.deepEqual(
    await logged("initialize", new RpcCallError({ cause: new Error("connection reset SECRET") })),
    [["Repository step failed", { step: "initialize", error: "RpcCallError", code: "reset" }]],
  );
  assert.deepEqual(await logged("coordinator-token", new ArtifactsError({ message: "SECRET" })), [
    [
      "Repository step failed",
      { step: "coordinator-token", error: "ArtifactsError", code: "unclassified" },
    ],
  ]);
  // A code that is not a provider's code shape is never logged as one.
  assert.deepEqual(
    await logged(
      "coordinator-open",
      new ArtifactsError({ message: "x", cause: { code: "lower secret" } }),
    ),
    [
      [
        "Repository step failed",
        { step: "coordinator-open", error: "ArtifactsError", code: "non_error" },
      ],
    ],
  );
  assert.deepEqual(await logged("credentials", new Error("Worker exceeded memory limit SECRET")), [
    ["Repository step failed", { step: "credentials", error: "memory_limit" }],
  ]);
  assert.deepEqual(await logged("decrypt", "SECRET thrown string"), [
    ["Repository step failed", { step: "decrypt", error: "non_error" }],
  ]);
  for (const message of [
    await logged("coordinator-token", new ArtifactsError({ message: "SECRET" })),
    await logged("credentials", new Error("Worker exceeded memory limit SECRET")),
  ])
    assert.ok(!JSON.stringify(message).includes("SECRET"));
});
