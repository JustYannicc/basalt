import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { StorageError } from "@executor-js/sdk/core";
import { makePoolViewCache } from "../../.upstream/apps/hosted/server/src/implementation/pool-view-cache.ts";

for (const cause of ["changed head", "guard read failure"] as const) {
  test(`a ${cause} after a view read returns one fresh uncached read in the same request`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const cache = makePoolViewCache();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let revision = "1";
        let guards = 0;
        let reads = 0;
        const guard = Effect.suspend(() => {
          guards++;
          return cause === "guard read failure" && guards === 2
            ? Effect.fail(new StorageError())
            : Effect.succeed({ revisions: [{ topic: "accounts", resource: "*", revision }] });
        });
        const read = Effect.gen(function* () {
          reads++;
          const value = { revision };
          if (reads === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return value;
        });
        const request = yield* cache("caller", guard, read).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        revision = "2";
        yield* Deferred.succeed(release, undefined);
        assert.deepEqual(yield* Fiber.join(request), { revision: "2" });
        assert.equal(reads, 2, "the stale fill is discarded and re-read once");
        assert.equal(guards, 2, "the fallback bypasses the cache guard");
        assert.deepEqual(yield* cache("caller", guard, read), { revision: "2" });
        assert.equal(reads, 3, "the fallback did not populate the cache");
        yield* cache("caller", guard, read);
        assert.equal(reads, 3, "a later stable fill can be cached normally");
      }),
    ));
}

test("heads advancing on every read do not create a retry loop or cache the fallback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let revision = 0;
      let guards = 0;
      const guard = Effect.sync(() => {
        guards++;
        return { revisions: [{ topic: "apps", resource: "*", revision: String(revision) }] };
      });
      const read = Effect.sync(() => ({ revision: ++revision }));
      assert.deepEqual(yield* cache("caller", guard, read), { revision: 2 });
      assert.equal(revision, 2);
      assert.equal(guards, 2);
      assert.deepEqual(yield* cache("caller", guard, read), { revision: 4 });
      assert.equal(revision, 4);
      assert.equal(guards, 4);
    }),
  ));

test("an authoritative refusal from the uncached read remains a failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let revision = 0;
      let reads = 0;
      const refusal = new StorageError();
      const guard = Effect.sync(() => ({
        revisions: [{ topic: "membership", resource: "*", revision: String(revision) }],
      }));
      const read = Effect.suspend(() => {
        reads++;
        revision++;
        return reads === 1 ? Effect.succeed({ private: "old" }) : Effect.fail(refusal);
      });
      assert.equal(yield* cache("caller", guard, read).pipe(Effect.flip), refusal);
      assert.equal(reads, 2, "the authoritative read gets the final decision");
    }),
  ));

test("authority expiring during the fill still fails closed without a retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let expired = false;
      let reads = 0;
      const guard = Effect.sync(() => ({
        revisions: [],
        validUntil: expired ? 0 : Date.now() + 60_000,
      }));
      const read = Effect.sync(() => {
        reads++;
        expired = true;
        return { windows: [1] };
      });
      assert.equal((yield* cache("caller", guard, read).pipe(Effect.result))._tag, "Failure");
      assert.equal(reads, 1);
    }),
  ));
