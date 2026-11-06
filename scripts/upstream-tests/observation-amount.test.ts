import assert from "node:assert/strict";
import { test } from "node:test";

const { amount, balanceView } = (await import(
  new URL(
    "../../.upstream/packages/ui/src/implementation/dashboard/account-observation-format.ts",
    import.meta.url,
  ).href
)) as typeof import("../../.upstream/packages/ui/src/implementation/dashboard/account-observation-format.ts");

const format = { locale: "en-US", timeZone: "UTC" };

test("a reported amount names one unit in the singular and any other count in the plural", () => {
  assert.equal(amount(1, "resets", format, true), "1 reset");
  assert.equal(amount(2, "resets", format, true), "2 resets");
  assert.equal(amount(0, "resets", format, true), "0 resets");
  assert.equal(amount(1.5, "credits", format, true), "1.5 credits");
  assert.equal(amount(1, "credits", format, true), "1 credit");
  assert.equal(amount(1, "requests", format, true), "1 request");
  // Displayed as 1, so read as one.
  assert.equal(amount(1.001, "resets", format, true), "1 reset");
  // Units without a known singular keep their spelling.
  for (const unit of ["ms", "Mbps", "queries", "status", "access", "GB"])
    assert.equal(amount(1, unit, format, true), `1 ${unit}`);
  assert.equal(amount(1, "%", format, true), "1%");
  assert.equal(amount(1, "resets", format), "1");
});

test("a banked credit's Details amount reads one reset", () => {
  const now = Date.parse("2026-11-06T08:00:00Z");
  const credit = (available: number) =>
    balanceView(
      { label: "Banked resets", unit: "resets", available, expiresAt: "2026-12-03T08:00:00Z" },
      now,
      format,
    ).detail;
  assert.equal(credit(1), "1 reset");
  assert.equal(credit(2), "2 resets");
});
