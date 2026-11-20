import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Atom, AtomRegistry, AsyncResult } = await import(require.resolve("effect/reactivity"));
const { Effect, Schema } = await import(require.resolve("effect"));
const { hydratedResult } = await import("../../.upstream/packages/ui/src/contracts/http.ts");
const { revalidated } = await import("../../.upstream/packages/ui/src/contracts/refresh.ts");
const { applyAtoms } =
  await import("../../.upstream/packages/dashboard-start/src/implementation/hydrate-atoms.ts");

const seconds = (count: number) => count * 1000;

/**
 * One document. The server read a value `age` before it sent the page, both by its own clock. The
 * browser's clock reads `ahead` of the server's when it applies the page and shows the value.
 * Returns how often the browser then read the value itself.
 */
const browserReads = ({ ahead, age }: { readonly ahead: number; readonly age: number }) => {
  let reads = 0;
  const query = Atom.make(
    Effect.sync(() => {
      reads++;
      return "read by the browser";
    }),
  ).pipe(hydratedResult({ key: `fixture:freshness:${ahead}:${age}`, success: Schema.String }));
  const shown = revalidated(query);

  const browserNow = Date.now();
  const serverNow = browserNow - ahead;
  // What the server's render sends for a settled read: its own codec's encoding and its own times.
  const page = [
    {
      "~effect/reactivity/Hydration/DehydratedAtom": true as const,
      key: query[Atom.SerializableTypeId].key,
      value: query[Atom.SerializableTypeId].encode(
        AsyncResult.success("read by the server", { timestamp: serverNow - age }),
      ),
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
    applyAtoms(browser, page);
    browser.mount(shown);
    for (let task = deferred.shift(); task !== undefined; task = deferred.shift()) task();
    assert.equal(
      browser.get(shown)._tag,
      "Success",
      "the page shows a value, the server's or the browser's own",
    );
    return reads;
  } finally {
    browser.dispose();
  }
};

for (const [clocks, ahead] of [
  ["the browser's clock is 60 s ahead of the server's", seconds(60)],
  ["the clocks agree", 0],
  ["the browser's clock is 60 s behind the server's", seconds(-60)],
] as const) {
  test(`${clocks}: a fresh document reads no hydrated value again`, () => {
    assert.equal(browserReads({ ahead, age: 0 }), 0);
  });

  test(`${clocks}: a value read 29 s before the page was sent is still fresh`, () => {
    assert.equal(browserReads({ ahead, age: seconds(29) }), 0);
  });

  test(`${clocks}: a value read 31 s before the page was sent is read again`, () => {
    assert.equal(browserReads({ ahead, age: seconds(31) }), 1);
  });
}
