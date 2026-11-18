import assert from "node:assert/strict";
import { test } from "node:test";
import { captureAllowanceExpiry, type SentryEnv } from "./sentry.ts";

const env: SentryEnv = {
  SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
  SENTRY_OTLP_ENDPOINT: "https://o123.ingest.de.sentry.io/api/456/integration/otlp/v1/traces",
};

test("each expiring plan opens its own error issue and a failed delivery is reported", async () => {
  const events: Record<string, unknown>[] = [];
  let status = 200;
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const lines = (await new Response(init?.body).text()).split("\n");
    events.push(JSON.parse(lines[2]!));
    return new Response(null, { status });
  };
  const rows = [
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
  ];
  const delivered: boolean[] = [];
  try {
    delivered.push(await captureAllowanceExpiry(env, rows));
    status = 503;
    delivered.push(await captureAllowanceExpiry(env, rows.slice(0, 1)));
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(delivered, [true, false]);
  assert.deepEqual(
    events.slice(0, 2).map((event) => [event.level, event.fingerprint, event.message]),
    [
      [
        "error",
        ["basalt", "pool_allowance_expiring", "anthropic/max_20x/604800s"],
        "pool_allowance_expiring anthropic/max_20x/604800s expires 2026-11-27",
      ],
      [
        "error",
        ["basalt", "pool_allowance_expiring", "openai/pro/604800s"],
        "pool_allowance_expiring openai/pro/604800s expires 2026-11-23",
      ],
    ],
  );
});
