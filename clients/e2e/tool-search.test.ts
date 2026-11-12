import assert from "node:assert/strict";
import { test } from "node:test";
import { readToolSearch } from "../connection/tool-search.ts";

const unavailable = {
  app: "calendar-fixture",
  name: "Calendar fixture",
  reason: JSON.stringify({ code: "AppDiscoveryTimedOut", retryable: true }),
};

for (const items of [
  [],
  [{ path: "tools.healthy.list", description: "List records", input: "{}" }],
])
  test(`search keeps unavailable sources beside ${items.length} matches`, () => {
    const page = readToolSearch({
      items,
      remaining: 0,
      next: null,
      unavailableApps: [unavailable],
    });
    assert.deepEqual(page.unavailableApps, [unavailable]);
    assert.deepEqual(page.items, items);
  });

test("a response without catalog completeness cannot become a no-match result", () => {
  assert.throws(() => readToolSearch({ items: [], remaining: 0, next: null }));
});

test("a complete empty search has no unavailable sources", () => {
  assert.deepEqual(
    readToolSearch({ items: [], remaining: 0, next: null, unavailableApps: [] }).unavailableApps,
    [],
  );
});
