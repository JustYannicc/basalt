import assert from "node:assert/strict";
import { test } from "node:test";

/** Counts number formatting, which initializes ICU and costs every importing Worker startup CPU. */
const formatted: string[] = [];
const toLocaleString = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function (...args) {
  formatted.push(String(this));
  return toLocaleString.apply(this, args);
};
const NumberFormat = Intl.NumberFormat;
Intl.NumberFormat = new Proxy(NumberFormat, {
  construct(target, args) {
    formatted.push("Intl.NumberFormat");
    return Reflect.construct(target, args);
  },
});

const { failureDetail } =
  await import("../.upstream/packages/apps/src/implementation/failure-detail.ts");
const { CacheError } = await import("../.upstream/packages/app-cache/src/contracts/cache.ts");
const formattedAtImport = [...formatted];

test("importing failure details formats no numbers", () => {
  assert.deepEqual(formattedAtImport, []);
});

test("cache limit messages keep their exact text", () => {
  const expected = {
    keyBytes: "A cache key exceeded the app cache's limit of 8,192 bytes per key.",
    entryBytes: "A cache value exceeded the app cache's limit of 2,000,000 bytes per entry.",
    batchBytes:
      "A cache read or write exceeded the app cache's limit of 8,000,000 bytes per batch.",
    batchEntries: "A cache read or write exceeded the app cache's limit of 128 entries per batch.",
    totalBytes: "The app cache is full: it holds at most 128,000,000 bytes.",
    totalEntries: "The app cache is full: it holds at most 100,000 entries.",
  } as const;
  for (const [limit, message] of Object.entries(expected))
    assert.equal(
      failureDetail(
        new CacheError({ reason: "capacity", limit: limit as keyof typeof expected }),
        [],
      ).message,
      message,
    );
  assert.equal(
    failureDetail(new CacheError({ reason: "timeout" }), []).message,
    "The app cache did not respond in time.",
  );
});
