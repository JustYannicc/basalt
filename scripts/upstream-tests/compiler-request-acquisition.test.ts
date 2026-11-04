import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { RuntimeBuildFailed } from "../../.upstream/packages/sdk/src/core.ts";
import {
  requestCompile,
  withCompilerRequest,
} from "../../.upstream/apps/hosted/cloud/src/implementation/compiler-request.ts";

const heldReply = () => {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Disposable>();
  const disposed = Promise.withResolvers<void>();
  let disposals = 0;
  const target = {
    [Symbol.dispose]() {
      disposals++;
      disposed.resolve();
    },
  };
  return {
    started: started.promise,
    acquire: Effect.promise(() => {
      started.resolve();
      return reply.promise;
    }),
    deliver: () => reply.resolve(target),
    disposed: disposed.promise,
    disposals: () => disposals,
  };
};

test(
  "caller interruption finishes before a held compiler request reply and disposes it later",
  {
    timeout: 5000,
  },
  async (context) => {
    const reply = heldReply();
    const controller = new AbortController();
    let used = false;
    const result = Effect.runPromise(
      requestCompile(
        withCompilerRequest(reply.acquire, () =>
          Effect.sync(() => {
            used = true;
          }),
        ),
      ),
      { signal: AbortSignal.any([context.signal, controller.signal]) },
    );
    try {
      await reply.started;
      controller.abort();
      await assert.rejects(result);
      assert.equal(used, false);
      assert.equal(reply.disposals(), 0);
      reply.deliver();
      await reply.disposed;
      assert.equal(reply.disposals(), 1);
    } finally {
      controller.abort();
      reply.deliver();
      await result.catch(() => {});
    }
  },
);

test(
  "the existing compiler request deadline finishes before a held reply and disposes it later",
  {
    timeout: 5000,
  },
  async (context) => {
    const reply = heldReply();
    let used = false;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* requestCompile(
            withCompilerRequest(reply.acquire, () =>
              Effect.sync(() => {
                used = true;
              }),
            ),
          ).pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => reply.started);
          yield* TestClock.adjust(100_000);
          const result = yield* Fiber.join(response);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.ok(Schema.is(RuntimeBuildFailed)(result.failure));
          assert.equal(used, false);
          assert.equal(reply.disposals(), 0);
          reply.deliver();
          yield* Effect.promise(() => reply.disposed);
          assert.equal(reply.disposals(), 1);
        }).pipe(Effect.provide(TestClock.layer())),
        { signal: context.signal },
      );
    } finally {
      reply.deliver();
    }
  },
);

test(
  "interruption during compile disposes the acquired compiler request exactly once",
  {
    timeout: 5000,
  },
  async (context) => {
    const reply = heldReply();
    const compiling = Promise.withResolvers<void>();
    const controller = new AbortController();
    const result = Effect.runPromise(
      requestCompile(
        withCompilerRequest(reply.acquire, () =>
          Effect.sync(() => compiling.resolve()).pipe(Effect.andThen(Effect.never)),
        ),
      ),
      { signal: AbortSignal.any([context.signal, controller.signal]) },
    );
    try {
      reply.deliver();
      await compiling.promise;
      controller.abort();
      await assert.rejects(result);
      assert.equal(reply.disposals(), 1);
    } finally {
      controller.abort();
      reply.deliver();
      await result.catch(() => {});
    }
  },
);
