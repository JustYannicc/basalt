import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Atom, AtomRegistry, AsyncResult } = await import(require.resolve("effect/reactivity"));
const { Cause, Effect, Option, Schema } = await import(require.resolve("effect"));
const { hydratedResult } = await import("../../.upstream/packages/ui/src/contracts/http.ts");
const { revalidated } = await import("../../.upstream/packages/ui/src/contracts/refresh.ts");
const { applyAtoms } =
  await import("../../.upstream/packages/dashboard-start/src/implementation/hydrate-atoms.ts");

const seconds = (count: number) => count * 1000;
const fromServer = "read by the server";
const fromBrowser = "read by the browser";

/** The results a document can carry with a time on them, read by the server at `timestamp`. */
const results = {
  "a success": (timestamp: number) => AsyncResult.success(fromServer, { timestamp }),
  "a failure that still holds an earlier success": (timestamp: number) =>
    AsyncResult.failure(Cause.fail("refused"), {
      previousSuccess: Option.some(AsyncResult.success(fromServer, { timestamp })),
    }),
};
type Sent = keyof typeof results;

/**
 * One document. The server read a value `age` before it sent the page, both by its own clock. The
 * browser's clock reads `ahead` of the server's when it applies the page and shows the value.
 * Returns how often the browser then read the value itself, and whose value it shows.
 */
const fresh = ({
  sent,
  ahead,
  age,
}: {
  readonly sent: Sent;
  readonly ahead: number;
  readonly age: number;
}) => {
  let reads = 0;
  const query = Atom.make(
    Effect.sync(() => {
      reads++;
      return fromBrowser;
    }),
  ).pipe(
    hydratedResult({
      key: `fixture:freshness:${sent}:${ahead}:${age}`,
      success: Schema.String,
      error: Schema.String,
    }),
  );
  const shown = revalidated(query);

  const browserNow = Date.now();
  const serverNow = browserNow - ahead;
  // What the server's render sends for a settled read: its own codec's encoding and its own times.
  const page = [
    {
      "~effect/reactivity/Hydration/DehydratedAtom": true as const,
      key: query[Atom.SerializableTypeId].key,
      value: query[Atom.SerializableTypeId].encode(results[sent](serverNow - age)),
      dehydratedAt: serverNow,
    },
  ];

  // The registry defers a background read through its scheduler; running the queue dry is the
  // point after which a read the page was going to start has started.
  const deferred: Array<() => void> = [];
  const browser = AtomRegistry.make({
    scheduleTask: (task: () => void) => {
      deferred.push(task);
      return () => {
        const index = deferred.indexOf(task);
        if (index !== -1) deferred.splice(index, 1);
      };
    },
  });
  try {
    applyAtoms(browser, page, browserNow);
    browser.mount(shown);
    for (let task = deferred.shift(); task !== undefined; task = deferred.shift()) task();
    return { reads, shows: Option.getOrNull(AsyncResult.value(browser.get(shown))) };
  } finally {
    browser.dispose();
  }
};

const kept = { reads: 0, shows: fromServer };
const readAgain = { reads: 1, shows: fromBrowser };

for (const [clocks, ahead] of [
  ["the browser's clock is 60 s ahead of the server's", seconds(60)],
  ["the clocks agree", 0],
  ["the browser's clock is 60 s behind the server's", seconds(-60)],
] as const) {
  for (const sent of ["a success", "a failure that still holds an earlier success"] as const) {
    test(`${clocks}: a fresh document does not read ${sent} again`, () => {
      assert.deepEqual(fresh({ sent, ahead, age: 0 }), kept);
    });

    // 30 s is the freshness. The lower case leaves room for a slow machine between the page's
    // arrival and its first view, which run on the real clock here.
    test(`${clocks}: ${sent} read 25 s before the page was sent is still fresh`, () => {
      assert.deepEqual(fresh({ sent, ahead, age: seconds(25) }), kept);
    });

    test(`${clocks}: ${sent} read 31 s before the page was sent is read again`, () => {
      assert.deepEqual(fresh({ sent, ahead, age: seconds(31) }), readAgain);
    });
  }
}
