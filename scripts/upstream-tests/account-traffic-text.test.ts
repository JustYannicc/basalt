import assert from "node:assert/strict";
import { test } from "node:test";

const text = (await import(
  new URL(
    "../../.upstream/packages/ui/src/implementation/dashboard/account-traffic-text.ts",
    import.meta.url,
  ).href
)) as typeof import("../../.upstream/packages/ui/src/implementation/dashboard/account-traffic-text.ts");

const format = { locale: "en-US", timeZone: "UTC" };
const now = Date.parse("2026-11-06T14:00:00Z");
const traffic = (requests: number, failed = 0) => ({
  requests,
  failed,
  ticks: [],
  lastSuccessAt: null,
  gateways: ["tool calls"],
});
const tokens = (known: number, missing: number) => ({
  total: 10,
  known,
  missing,
  gateways: ["Traffic pool"],
});

test("one request reads in the singular on the row's tooltips", () => {
  assert.equal(
    text.requestsTitle(traffic(1, 1), now, format),
    "1 request in the last 7 days, counted by tool calls",
  );
  assert.equal(
    text.healthTitle(traffic(1, 1), undefined, now, format),
    "1 request in 7 days · 0% succeeded · no successful request recorded, counted by tool calls",
  );
});

test("two requests read in the plural on the row's tooltips", () => {
  assert.equal(
    text.requestsTitle(traffic(2), now, format),
    "2 requests in the last 7 days, counted by tool calls",
  );
  assert.equal(
    text.healthTitle(traffic(2), "Healthy", now, format),
    "2 requests in 7 days · 100% succeeded · no successful request recorded, counted by tool calls\nHealthy",
  );
});

test("Details' Requests line counts without a noun at one and two", () => {
  assert.equal(
    text.trafficSummary(traffic(1, 1), now, format),
    "1 in 7 days · 0% succeeded · no successful request recorded · counted by tool calls",
  );
  assert.equal(
    text.trafficSummary(traffic(2), now, format),
    "2 in 7 days · 100% succeeded · no successful request recorded · counted by tool calls",
  );
});

test("the token footer's note names one request in the singular", () => {
  assert.match(
    text.tokensTitle(tokens(0, 1), undefined, format),
    /\n1 of 1 request didn't report tokens, so this is a minimum\.\n/,
  );
  assert.match(
    text.tokensTitle(tokens(1, 1), undefined, format),
    /\n1 of 2 requests didn't report tokens, so this is a minimum\.\n/,
  );
});

test("the screen-reader label and the token footer's unit name one in the singular", () => {
  assert.equal(text.requestsLabel(1), " request in the last 7 days");
  assert.equal(text.requestsLabel(2), " requests in the last 7 days");
  assert.equal(text.tokensUnit(1), " token");
  assert.equal(text.tokensUnit(2), " tokens");
  assert.equal(text.tokensUnit(1_200_000), " tokens");
});

test("a count keeps the reader's locale for its number and English for its noun", () => {
  assert.equal(
    text.requestsTitle(traffic(1234), now, { locale: "de-DE", timeZone: "UTC" }),
    "1.234 requests in the last 7 days, counted by tool calls",
  );
  // Russian reads 21 as "one" and Filipino reads 2 as "one"; the English noun stays plural.
  assert.equal(
    text.requestsTitle(traffic(21), now, { locale: "ru-RU", timeZone: "UTC" }),
    "21 requests in the last 7 days, counted by tool calls",
  );
  assert.equal(
    text.requestsTitle(traffic(2), now, { locale: "fil", timeZone: "UTC" }),
    "2 requests in the last 7 days, counted by tool calls",
  );
  assert.equal(text.requestsLabel(21), " requests in the last 7 days");
});
