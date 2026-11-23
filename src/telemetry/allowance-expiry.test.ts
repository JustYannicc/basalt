import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanAllowances } from "../pool/allowances/registry.ts";
import { allowanceExpiryEvents, captureAllowanceExpiry } from "./sentry.ts";

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

class Memory {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
}

test("an expiry report Sentry refuses for spent quota is not resent on the next 5 s upkeep pass", async (context) => {
  let clock = Date.parse("2026-11-22T15:00:00Z");
  const plan = (name: string) => ({
    vendor: "anthropic",
    plan: name,
    windowSeconds: 604_800,
    full: 5,
    unit: { id: "claude-pro-equivalent", label: "Pro-eq" },
    kind: "vendor" as const,
    verification: "verified" as const,
    sources: ["https://example.test/allowances.json"],
    checkedAt: Date.parse("2026-11-13T00:00:00Z"),
    fetchedAt: Date.parse("2026-11-13T00:00:00Z"),
    expiresAt: Date.parse("2026-11-27T00:00:00Z"),
    revision: name,
  });
  const registry = new PlanAllowances(new Memory(), {
    now: () => clock,
    seed: { entries: [plan("max_5x"), plan("max_20x")] },
  });
  let sentryAnswer = () =>
    new Response(null, {
      status: 429,
      headers: { "x-sentry-rate-limits": "60::organization:usage_exceeded" },
    });
  const sent = context.mock.method(globalThis, "fetch", async () => sentryAnswer());
  const env = { SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456" };
  const pass = () => registry.reportExpiring((rows) => captureAllowanceExpiry(env, rows));

  await pass();
  assert.equal(sent.mock.callCount(), 2, "one event per expiring plan");
  for (let i = 0; i < 12; i++) {
    clock += 5_000;
    await pass();
  }
  assert.equal(sent.mock.callCount(), 2, "resent into Sentry's refusal on every upkeep pass");
  assert.deepEqual(await registry.alertDelivery(), {
    refusedSince: Date.parse("2026-11-22T15:00:00Z"),
    lastStatus: 429,
  });

  clock = Date.parse("2026-11-22T15:31:00Z");
  sentryAnswer = () => new Response(null, { status: 200 });
  await pass();
  assert.equal(sent.mock.callCount(), 4, "tried again once the retry time passed");
  assert.equal(await registry.alertDelivery(), undefined);
  clock += 5_000;
  await pass();
  assert.equal(sent.mock.callCount(), 4, "a delivered report waits for the next day");
});

test("a refused expiry report waits as long as Sentry asked, past the registry's own 30 min", async (context) => {
  let clock = Date.parse("2026-11-22T15:00:00Z");
  const registry = new PlanAllowances(new Memory(), {
    now: () => clock,
    seed: {
      entries: [
        {
          vendor: "anthropic",
          plan: "max_5x",
          windowSeconds: 604_800,
          full: 5,
          unit: { id: "claude-pro-equivalent", label: "Pro-eq" },
          kind: "vendor" as const,
          verification: "verified" as const,
          sources: ["https://example.test/allowances.json"],
          checkedAt: Date.parse("2026-11-13T00:00:00Z"),
          fetchedAt: Date.parse("2026-11-13T00:00:00Z"),
          expiresAt: Date.parse("2026-11-27T00:00:00Z"),
          revision: "max_5x",
        },
      ],
    },
  });
  const sent = context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(null, {
        status: 429,
        headers: { "x-sentry-rate-limits": "7200:error:organization:usage_exceeded" },
      }),
  );
  const env = { SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456" };
  const pass = () => registry.reportExpiring((rows) => captureAllowanceExpiry(env, rows));
  await pass();
  clock = Date.parse("2026-11-22T15:31:00Z");
  await pass();
  assert.equal(sent.mock.callCount(), 1, "sent again before Sentry's two-hour wait was over");
  clock = Date.parse("2026-11-22T17:01:00Z");
  await pass();
  assert.equal(sent.mock.callCount(), 2);
});
