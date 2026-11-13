import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolReliability, ReliabilityCounts } from "../reliability-contract.ts";
import {
  brokenAnswer,
  failureItems,
  legacyBrokenAnswer,
  sloText,
  successText,
  type Reliability,
} from "./overview-reliability.ts";

const counts = (requests: number, failed = 0, unassignedFailures = 0): ReliabilityCounts => ({
  requests,
  failed,
  unassignedFailures,
  successRate: requests ? ((requests - failed) * 100) / requests : null,
  failures: [],
});
const window = (
  real: ReliabilityCounts,
  proof = counts(0),
  classification: PoolReliability["classification"] = "ready",
): PoolReliability => ({
  from: "2026-11-01T00:00:00.000Z",
  to: "2026-11-08T00:00:00.000Z",
  classification,
  real,
  proof,
});
const reliability = (
  range: PoolReliability,
  slo: Partial<Reliability["slo"]> = {},
): Reliability => ({
  range,
  slo: { target: 99, state: "ok", captureAt: null, hour: range, day: range, ...slo },
});

test("success rounds down and failure up, so neither edge of the target is misread", () => {
  assert.equal(successText(counts(10_000, 1)), "99.9%");
  assert.equal(successText(counts(100_000, 4)), "99.9%");
  assert.equal(successText(counts(10_000, 104)), "98.9%");
  assert.equal(successText(counts(5)), "100%");
  const one = brokenAnswer({
    needYou: 0,
    reliability: reliability(window(counts(100_000, 1))),
    viewRead: true,
  });
  assert.equal(one.answer, "0.1% of real requests failed");
});

test("proof checks never count as real failures and are shown apart", () => {
  const data = reliability(window(counts(200), counts(40, 3)));
  assert.deepEqual(brokenAnswer({ needYou: 0, reliability: data, viewRead: true }), {
    tone: "ok",
    answer: "Nothing broken",
    sub: ["1h 100% · 24h 100% · target 99%"],
  });
  assert.deepEqual(failureItems(data, 7), [
    {
      tone: "info",
      text: "3 of 40 proof checks failed in 7 days",
      sub: "Proof checks only, counted apart. No real request failed.",
    },
  ]);
  const mixed = failureItems(reliability(window(counts(200, 4, 1), counts(40, 3))), 7);
  assert.equal(mixed[0]!.text, "4 of 200 real requests failed in 7 days");
  assert.match(
    mixed[0]!.sub,
    /1 failed without a known account\. Proof checks counted apart: 3 of 40 failed\./,
  );
});

test("no real traffic says so and never claims 100%", () => {
  const quiet = reliability(window(counts(0), counts(12)), { state: "no_traffic" });
  const answer = brokenAnswer({ needYou: 0, reliability: quiet, viewRead: true });
  assert.equal(answer.answer, "No real requests");
  assert.equal(answer.tone, undefined);
  assert.doesNotMatch(answer.sub.join(" "), /100%/);
  assert.equal(sloText(quiet.slo), "1h and 24h: no real requests · target 99%");
  const hourQuiet = reliability(window(counts(500, 1)), { hour: window(counts(0)) });
  assert.equal(sloText(hourQuiet.slo), "1h no real requests · 24h 99.8% · target 99%");
});

test("a breach or an unavailable verdict is stated, not smoothed over", () => {
  const breached = reliability(window(counts(1000, 2)), {
    state: "breached",
    hour: window(counts(50, 2)),
  });
  const answer = brokenAnswer({ needYou: 0, reliability: breached, viewRead: true });
  assert.equal(answer.tone, "bad");
  assert.equal(answer.answer, "Below 99% success");
  assert.equal(failureItems(breached, 7)[0]!.text, "Real-request success is below the 99% target");
  const stale = reliability(window(counts(1000)), {
    state: "unavailable",
    reason: "capture_stale",
  });
  assert.equal(
    brokenAnswer({ needYou: 0, reliability: stale, viewRead: true }).answer,
    "Success rate unavailable",
  );
  assert.equal(failureItems(stale, 7)[0]!.text, "Request success rate unavailable");
  assert.deepEqual(brokenAnswer({ needYou: 0, reliability: stale, viewRead: true }).sub, [
    "Success vs 99% target unavailable: the last capture is over 10 minutes old",
  ]);
});

test("a failed optional reliability read stays explicit without hiding an account that needs attention", () => {
  const unavailable = { unavailable: true } as const;
  assert.equal(
    brokenAnswer({ needYou: 0, reliability: unavailable, viewRead: true }).answer,
    "Success rate unavailable",
  );
  assert.equal(
    brokenAnswer({ needYou: 1, reliability: unavailable, viewRead: true }).answer,
    "1 account needs you",
  );
  assert.equal(failureItems(unavailable, 7)[0]!.text, "Request success rate unavailable");
});

test("pending classification and old responses never call the total real", () => {
  const pending = reliability(window(counts(100, 5), counts(0), "pending"), {
    state: "unavailable",
    reason: "classification_pending",
  });
  const answer = brokenAnswer({ needYou: 0, reliability: pending, viewRead: true });
  assert.equal(answer.answer, "5.0% of requests failed");
  assert.ok(answer.sub.includes("Includes proof checks; not separated yet"));
  assert.doesNotMatch(failureItems(pending, 7)[1]!.text, /real/);
  const legacy = legacyBrokenAnswer({
    needYou: 0,
    sum: { requests: 100, failed: 5 },
    read: true,
    usage: true,
    viewRead: true,
    worstHourP95: null,
  });
  assert.equal(legacy.answer, "5.0% of requests failed");
  assert.deepEqual(legacy.sub, ["includes proof checks"]);
});

test("recent real failures remain visible when the longer success objective is met", () => {
  const data = reliability(window(counts(10000, 1)), { current: window(counts(5, 1)) });
  assert.equal(
    brokenAnswer({ needYou: 0, reliability: data, viewRead: true }).answer,
    "Requests are failing now",
  );
  assert.equal(failureItems(data, 7)[0]!.text, "1 real request failed in the last 5 minutes");
  const proofOnly = reliability(window(counts(100)), {
    current: window(counts(1), counts(50, 50)),
  });
  assert.equal(
    brokenAnswer({ needYou: 0, reliability: proofOnly, viewRead: true }).answer,
    "Nothing broken",
  );
});

test("pending classification cannot turn a proof failure into an urgent current outage", () => {
  const pending = window(counts(5, 1), counts(0), "pending");
  const data = reliability(pending, {
    current: pending,
    state: "unavailable",
    reason: "classification_pending",
  });
  assert.notEqual(
    brokenAnswer({ needYou: 0, reliability: data, viewRead: true }).answer,
    "Requests are failing now",
  );
  assert.ok(failureItems(data, 7).every((item) => item.tone !== "bad"));
});
