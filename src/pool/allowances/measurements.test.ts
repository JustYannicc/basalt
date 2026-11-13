import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountAllowanceMeasurements } from "./measurements.ts";
import { quotaObservation } from "../quota-observation.ts";
import { capacityReadings } from "../capacity/normalize.ts";

class Memory {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}
const start = Date.parse("2026-11-13T12:00:00Z");
const step = 300_000;
function account(at: number, remaining: number, resetAt = start + 604_800_000) {
  return {
    id: "synthetic-grok",
    provider: "xai",
    quota: quotaObservation({
      observed_at: new Date(at).toISOString(),
      freshness: "fresh",
      collection_status: "success",
      plan: { name: "Grok Pro" },
      windows: [
        {
          id: "xai-account-weekly",
          scope: "account",
          window_seconds: 604_800,
          period_mode: "fixed",
          remaining_ratio: remaining,
          observed_at: new Date(at).toISOString(),
          reset_at: new Date(resetAt).toISOString(),
          status: "healthy",
        },
      ],
    }),
  };
}
function feed(complete = true) {
  return {
    async data(path: string) {
      if (path === "/capabilities")
        return { capabilities: { usage_summary_cursor_v1: true, usage_token_breakdown_v2: true } };
      const url = new URL(path, "https://fixture.invalid");
      const from = Date.parse(url.searchParams.get("from")!),
        to = Date.parse(url.searchParams.get("to")!);
      const items = Array.from({ length: 25 }, (_, index) => ({
        id: String(index + 1),
        timestamp: new Date(start + index * 60_000).toISOString(),
        credential: { credential_id: "synthetic-grok" },
        provider: "xai",
        model: "synthetic-model",
        token_breakdown: {
          quality: complete ? "complete" : "incomplete",
          input: { uncached_tokens: 80, cache_read_tokens: 0, cache_write_tokens: 0 },
          output: { total_tokens: 20 },
          total_tokens: 100,
        },
      })).filter((row) => Date.parse(row.timestamp) >= from && Date.parse(row.timestamp) < to);
      return { items, next: null };
    },
  };
}

test("repeated account quota and complete request intervals reach pool capacity without a plan table", async () => {
  const measurements = new AccountAllowanceMeasurements(new Memory(), feed());
  let catalog = { entries: [] as readonly import("./data.ts").PlanAllowance[] };
  for (let index = 0; index <= 4; index++) {
    const current = account(start + index * step, 1 - index * 0.05);
    catalog = {
      entries: (await measurements.observe([current], start + index * step)).get(current.id)!,
    };
    if (index < 4) assert.equal(catalog.entries.length, 0);
  }
  const current = account(start + 4 * step, 0.8);
  const reading = capacityReadings(
    current.id,
    current.provider,
    current.quota,
    start + 4 * step,
    catalog,
  )[0]!;
  assert.equal(reading.full, 10_000);
  assert.equal(reading.remaining, 8_000);
  assert.equal(reading.source, "account-calibration");
  assert.equal(reading.allowance?.verification, "estimated");
  const reset = account(start + 5 * step, 1, start + 604_800_000 + step);
  assert.equal((await measurements.observe([reset], start + 5 * step)).get(reset.id)?.length, 0);
});

test("incomplete consumption never replaces an account reference unit", async () => {
  const measurements = new AccountAllowanceMeasurements(new Memory(), feed(false));
  for (let index = 0; index <= 5; index++) {
    const current = account(start + index * step, 1 - index * 0.05);
    assert.equal(
      (await measurements.observe([current], start + index * step)).get(current.id)?.length,
      0,
    );
  }
});
