import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { settleObserved } from "../../.upstream/packages/ui/src/contracts/observed-result.ts";

test("an account mutation waits for the mounted projection's accepted result", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const accepted = yield* Deferred.make<string>();
      let reads = 0;
      const query = Atom.make(
        Effect.sync(() => {
          reads++;
        }).pipe(Effect.andThen(Deferred.await(accepted))),
      );
      const unmount = registry.mount(query);
      try {
        let finished = false;
        const waiting = yield* settleObserved(registry, query).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        assert.equal(finished, false);
        assert.equal(reads, 1);
        yield* Deferred.succeed(accepted, "accepted failed check");
        yield* Fiber.join(waiting);
        assert.equal(finished, true);
        assert.equal(reads, 1, "joining an accepted read must not refresh it again");
        const result = registry.get(query);
        assert.ok(AsyncResult.isSuccess(result));
        if (AsyncResult.isSuccess(result)) assert.equal(result.value, "accepted failed check");
      } finally {
        unmount();
        registry.dispose();
      }
    }),
  );
});

test("a closed account view starts no reads, including through retained derived values", async () => {
  const registry = AtomRegistry.make();
  let reads = 0;
  const query = Atom.make(() => {
    reads++;
    return AsyncResult.success("old check");
  }).pipe(Atom.setIdleTTL("30 minutes"));
  const filtered = Atom.map(query, (value) => value).pipe(Atom.setIdleTTL("30 minutes"));
  try {
    await Effect.runPromise(settleObserved(registry, query));
    assert.equal(reads, 0);
    registry.get(filtered);
    assert.equal(reads, 1);
    registry.refresh(query);
    await Effect.runPromise(settleObserved(registry, query));
    assert.equal(reads, 1, "retention without a view must not activate a read");
  } finally {
    registry.dispose();
  }
});

test("an authoritative projection failure is not treated as accepted health", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const failed = yield* Deferred.make<string, string>();
      const query = Atom.make(Deferred.await(failed));
      const unmount = registry.mount(query);
      try {
        const waiting = yield* settleObserved(registry, query).pipe(
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.fail(failed, "projection refused");
        const outcome = yield* Fiber.join(waiting);
        assert.equal(outcome._tag, "Failure");
      } finally {
        unmount();
        registry.dispose();
      }
    }),
  );
});

test("a scheduled fence cannot finish a check with the previously settled result", async () => {
  const registry = AtomRegistry.make();
  const previous = AsyncResult.success("old healthy check");
  const source = Atom.make(previous);
  const query = Atom.map(source, (value) => value);
  const unmount = registry.mount(query);
  try {
    const completion = settleObserved(registry, query);
    let finished = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const waiting = yield* completion.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        assert.equal(finished, false, "a requested fence has not started its body yet");
        registry.set(source, AsyncResult.waiting(previous));
        yield* Effect.yieldNow;
        assert.equal(finished, false);
        registry.set(source, AsyncResult.success("accepted failed check"));
        yield* Fiber.join(waiting);
        assert.equal(finished, true);
      }),
    );
  } finally {
    unmount();
    registry.dispose();
  }
});
