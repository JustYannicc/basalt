import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import { capacityLabs } from "./capacity-model.ts";
import { capacityWindowOptions } from "./capacity-window-options.ts";

test("two fixed weekly units have distinct labels with each unit printed once", () => {
  const aggregate = {
    remaining: 1,
    full: 1,
    at: 0,
    observedAt: { from: 0, to: 0 },
    accountCount: 1,
    knownWeightCount: 1,
    unknownWeightCount: 0,
    weights: [],
  };
  const history: PoolCapacityHistory = {
    from: 0,
    to: 1,
    readAt: 1,
    trackingSince: 0,
    completedWeeks: 0,
    points: [
      { id: "account-eq", label: "account-eq" },
      { id: "grok-pro-account", label: "Grok Pro account" },
    ].map((unit) => ({
      provider: "grok",
      windowSeconds: 604800,
      mode: "fixed",
      unit,
      hour: 0,
      minimum: aggregate,
      last: aggregate,
      plans: [],
    })),
    forecasts: [],
    refillEvents: [],
    estimate: { status: "learning", reason: "No forecast" },
  };
  const lab = capacityLabs(history)[0]!;
  assert.deepEqual(
    capacityWindowOptions(lab.lines)
      .map((option) => option.label)
      .sort(),
    ["Weekly · fixed · Grok Pro account", "Weekly · fixed · account-eq"],
  );
});
