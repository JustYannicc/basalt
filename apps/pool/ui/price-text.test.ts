import assert from "node:assert/strict";
import { test } from "node:test";
import { priceNoteLines, priceSentence, slicePrice, type Price } from "./price-text.ts";

const price = (basis: Price["basis"], refreshFailed: boolean, asOf = "2026-11-03T00:00:00Z") => ({
  source: "models.dev",
  version: "v1",
  asOf,
  basis,
  refreshFailed,
});

test("a failed first refresh names the shipped baseline, never last good live prices", () => {
  const value = price("baseline", true);
  assert.deepEqual(priceSentence(value), {
    text: "Shipped baseline models.dev prices, as of 3 Nov 2026. Price refresh failed.",
    failed: true,
    detail: "models.dev v1",
  });
  assert.deepEqual(priceNoteLines(value), {
    lines: ["Refresh failed", "Baseline price as of 3 Nov"],
    failed: true,
  });
});

test("a failed refresh after a live read keeps the last good prices", () => {
  const value = price("live", true, "2026-11-10T06:00:00Z");
  assert.equal(
    priceSentence(value).text,
    "Price refresh failed. Last good models.dev prices, as of 10 Nov 2026.",
  );
  assert.deepEqual(priceNoteLines(value), { lines: ["Refresh failed · 10 Nov"], failed: true });
});

test("rows stay quiet for live rates and date baseline rates", () => {
  assert.equal(priceNoteLines(price("live", false)), null);
  assert.deepEqual(priceNoteLines(price("baseline", false)), {
    lines: ["Price as of 3 Nov"],
    failed: false,
  });
});

test("mixing a failed live slice with a baseline slice reports both", () => {
  const value = slicePrice([
    { price: price("live", true, "2026-11-10T06:00:00Z") },
    {
      price: {
        source: "models.dev",
        version: "v1",
        asOf: "2026-11-03T00:00:00Z",
        basis: "baseline",
      },
    },
  ]);
  assert.equal(
    priceSentence(value).text,
    "Shipped baseline models.dev prices, as of 3 Nov 2026. Price refresh failed.",
  );
});
