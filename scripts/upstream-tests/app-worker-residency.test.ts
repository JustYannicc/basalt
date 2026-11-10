import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

// Workerd source is checked in the SDK project, under its own ambient types and compiler options.
const {
  makeAppWorkerResidency,
}: {
  makeAppWorkerResidency: (options: { limit: number; idleSeconds: number }) => {
    hold: (
      name: string,
      unload: { run: Effect.Effect<boolean>; abandon: () => void },
      waitUntil: (task: Promise<unknown>) => void,
    ) => Effect.Effect<Effect.Effect<void>>;
  };
} = await import(
  new URL(
    "../../.upstream/packages/sdk/src/implementation/app-worker-residency.ts",
    import.meta.url,
  ).href
);

test("an idle selection refused while another selection of its app is busy stays tracked", async () => {
  const loaded = new Set<string>();
  const attempts: string[] = [];
  let busy = false;
  const residency = makeAppWorkerResidency({ limit: 1, idleSeconds: 0 });
  const hold = (name: string) =>
    residency.hold(
      name,
      {
        run: Effect.sync(() => {
          attempts.push(name);
          // The facet supervisor admits one selection at a time and refuses any unload while busy.
          if (busy) return false;
          return loaded.delete(name);
        }),
        abandon: () => assert.fail("a refusal must not abandon the loaded selection"),
      },
      () => assert.fail("idle expiry is disabled"),
    );
  await Effect.runPromise(
    Effect.gen(function* () {
      const releaseA = yield* hold("data:app:selection-a");
      loaded.add("data:app:selection-a");
      yield* releaseA;
      busy = true;
      const releaseB = yield* hold("data:app:selection-b");
      loaded.add("data:app:selection-b");
      assert.deepEqual(attempts, ["data:app:selection-a"]);
      assert.equal(loaded.size, 2, "the busy supervisor temporarily prevents eviction");
      busy = false;
      yield* releaseB;
      assert.deepEqual(attempts, ["data:app:selection-a", "data:app:selection-a"]);
      assert.deepEqual([...loaded], ["data:app:selection-b"]);
      // More selections cannot accumulate forgotten Workers after the refusal.
      for (let index = 0; index < 8; index++) {
        const name = `data:app:selection-${index}`;
        const release = yield* hold(name);
        loaded.add(name);
        yield* release;
        assert.equal(loaded.size, 1, "loaded selections return to the configured bound");
      }
    }),
  );
});

test("a refused idle expiry stays resident and retries after the idle interval", async () => {
  let loaded = true;
  let refused = true;
  let attempts = 0;
  const background: Promise<unknown>[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const residency = makeAppWorkerResidency({ limit: 2, idleSeconds: 1 });
      const release = yield* residency.hold(
        "data:app:selection-a",
        {
          run: Effect.sync(() => {
            attempts++;
            if (refused) return false;
            loaded = false;
            return true;
          }),
          abandon: () => assert.fail("a refusal must not abandon the loaded selection"),
        },
        (task) => background.push(task),
      );
      yield* release;
      yield* TestClock.adjust(1000);
      assert.equal(attempts, 1, "a refused expiry does not immediately retry in a loop");
      assert.equal(loaded, true);
      refused = false;
      yield* TestClock.adjust(1000);
      assert.equal(attempts, 2, "the refused selection remains eligible for a later sweep");
      assert.equal(loaded, false);
      yield* Effect.promise(() => Promise.all(background));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
