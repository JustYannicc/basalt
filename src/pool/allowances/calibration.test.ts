import assert from "node:assert/strict";
import { test } from "node:test";
import { calibratedAllowance, type CalibrationSample } from "./calibration.ts";

const now = Date.parse("2026-11-13T12:00:00Z");
const samples: CalibrationSample[] = [0, 1, 2].map((index) => ({
  from: now - (3 - index) * 300_000,
  to: now - (2 - index) * 300_000,
  fraction: 0.05,
  tokens: 500,
  requests: 5,
  profile: "synthetic-model-standard",
}));

test("several same-window measurements size an account before a published plan table", () => {
  const result = calibratedAllowance({
    vendor: "xai",
    plan: "grok_pro",
    windowSeconds: 604_800,
    samples,
    now,
  });
  assert.equal(result?.full, 10_000);
  assert.equal(result?.verification, "estimated");
  assert.equal(result?.kind, "account-calibration");
  assert.equal(result?.checkedAt, now);
  assert.equal(
    calibratedAllowance({
      vendor: "xai",
      plan: "grok_pro",
      windowSeconds: 604_800,
      samples: samples.slice(0, 2),
      now,
    }),
    null,
  );
});

test("reset, overlap, changed workload and inconsistent intervals cannot establish an allowance", () => {
  for (const invalid of [
    samples.map((sample, i) => (i === 1 ? { ...sample, from: samples[0]!.from } : sample)),
    samples.map((sample, i) => (i === 1 ? { ...sample, tokens: 5_000 } : sample)),
    samples.map((sample, i) => (i === 1 ? { ...sample, profile: "different" } : sample)),
    samples.map((sample) => ({
      ...sample,
      to: sample.to - 2 * 86_400_000,
      from: sample.from - 2 * 86_400_000,
    })),
  ])
    assert.equal(
      calibratedAllowance({
        vendor: "xai",
        plan: "grok_pro",
        windowSeconds: 604_800,
        samples: invalid,
        now,
      }),
      null,
    );
});
