import assert from "node:assert/strict";
import { test } from "node:test";
import { allowanceExpiryEvents } from "./sentry.ts";

test("each expiring plan opens its own error issue, naming only the plan", () => {
  const events = allowanceExpiryEvents([
    {
      vendor: "anthropic",
      plan: "max_20x",
      windowSeconds: 604_800,
      expiresAt: Date.parse("2026-11-27T00:00:00Z"),
    },
    {
      vendor: "openai",
      plan: "pro",
      windowSeconds: 604_800,
      expiresAt: Date.parse("2026-11-23T00:00:00Z"),
    },
  ]);
  assert.deepEqual(
    events.map((event) => [event.level, event.fingerprint, event.message, event.tags]),
    [
      [
        "error",
        ["basalt", "pool_allowance_expiring", "anthropic/max_20x/604800s"],
        "pool_allowance_expiring anthropic/max_20x/604800s expires 2026-11-27",
        { error_code: "pool_allowance_expiring", allowance_plan: "anthropic/max_20x/604800s" },
      ],
      [
        "error",
        ["basalt", "pool_allowance_expiring", "openai/pro/604800s"],
        "pool_allowance_expiring openai/pro/604800s expires 2026-11-23",
        { error_code: "pool_allowance_expiring", allowance_plan: "openai/pro/604800s" },
      ],
    ],
  );
  assert.notEqual(events[0]!.event_id, events[1]!.event_id);
});
