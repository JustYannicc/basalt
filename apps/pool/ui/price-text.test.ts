import assert from "node:assert/strict";
import { test } from "node:test";
import { priceNoteLines, priceSentence, samePrice, slicePrice, type Price } from "./price-text.ts";

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

const counted = (value: Price): Price => ({ ...value, calculation: "token-counts" });

test("token-count pricing shows even on live rates, and older servers never imply it", () => {
  assert.deepEqual(priceNoteLines(counted(price("live", false))), {
    lines: ["Priced from token counts"],
    failed: false,
  });
  assert.equal(
    priceSentence(counted(price("live", false))).text,
    "Live models.dev prices, updated 3 Nov 2026. Priced from token counts where usage details were missing.",
  );
  const old = slicePrice([
    { price: { source: "models.dev", version: "v1", asOf: "2026-11-03T00:00:00Z" } },
  ]);
  assert.equal(old !== null && "calculation" in old, false);
  assert.equal(priceNoteLines(old), null);
});

test("token-count pricing sits beside date and failed-refresh notes, never replacing them", () => {
  assert.deepEqual(priceNoteLines(counted(price("baseline", false))), {
    lines: ["Price as of 3 Nov", "Priced from token counts"],
    failed: false,
  });
  assert.deepEqual(priceNoteLines(counted(price("baseline", true))), {
    lines: ["Refresh failed", "Baseline price as of 3 Nov", "Priced from token counts"],
    failed: true,
  });
  const failed = priceSentence(counted(price("live", true, "2026-11-10T06:00:00Z")));
  assert.equal(failed.failed, true);
  assert.equal(
    failed.text,
    "Price refresh failed. Last good models.dev prices, as of 10 Nov 2026. Priced from token counts where usage details were missing.",
  );
});

test("mixed slices keep the token-count basis whichever slice is older", () => {
  const value = slicePrice([
    { price: { ...price("live", false, "2026-11-12T00:00:00Z"), calculation: "token-counts" } },
    { price: price("live", false, "2026-11-01T00:00:00Z") },
  ]);
  assert.equal(value?.asOf, "2026-11-01T00:00:00Z");
  assert.equal(value?.calculation, "token-counts");
});

test("an API cell and a subscription cell differing only in token counts both keep a note", () => {
  const live = price("live", false);
  assert.equal(samePrice(live, counted(live)), false);
  assert.equal(samePrice(counted(live), counted(live)), true);
});
