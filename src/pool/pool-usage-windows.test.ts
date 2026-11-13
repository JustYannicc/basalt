import assert from "node:assert/strict";
import { test } from "node:test";
import { callerHeader } from "../../apps/pool/contract.ts";
import { quotaSamplingFixture } from "./quota-sampling.test-helpers.ts";
import { signPoolToken } from "./token.ts";

test("the alarm retains a five-hour allowance crowded out of Home's list summary", async () => {
  const at = Date.parse("2026-11-09T08:01:00Z");
  const f = quotaSamplingFixture(at);
  assert.deepEqual(
    f.credential.primary_windows.map((window) => window.window_seconds),
    [604_800, 604_800],
  );
  await f.usage.observe();
  const token = await signPoolToken("ab".repeat(32), {
    pool: "fixture",
    owner: "owner",
    organization: "synthetic",
  });
  const response = await f.usage.handle(
    new Request("https://pool.example.test/pool/v1/usage/capacity?days=7", {
      headers: { authorization: `Bearer ${token}`, [callerHeader]: "owner" },
    }),
  );
  assert.equal(response.status, 200);
  const value = await f.capacity(Math.floor((at - 7 * 86_400_000) / 3_600_000) * 3_600_000, at);
  assert.deepEqual(await response.json(), value);
  assert.deepEqual(
    value.points.map((point) => point.windowSeconds).sort((a, b) => a - b),
    [18_000, 604_800],
  );
  for (const point of value.points) {
    assert.equal(point.last.accountCount, 1, "Spark is not a second physical account");
    assert.equal(point.last.full, 1);
    assert.equal(point.last.remaining, point.windowSeconds === 18_000 ? 0.75 : 0.6);
  }
  assert.equal(f.calls.filter((route) => route === "/quota/credentials").length, 0);
  assert.equal(f.calls.filter((route) => route.startsWith("/quota/credentials/")).length, 1);
});

test("a failed detail collection leaves a capacity gap despite fresh credential summary metadata", async () => {
  const f = quotaSamplingFixture(Date.parse("2026-11-09T08:01:00Z"));
  f.detail.collection.status = "failed";
  await f.usage.observe();
  assert.deepEqual(await f.history.read("fixture"), []);
});

test("90-day capacity reads preserve the requested bounds and real tracking start", async () => {
  const at = Date.parse("2026-11-12T08:01:00Z");
  const f = quotaSamplingFixture(at);
  await f.usage.observe();
  const token = await signPoolToken("ab".repeat(32), {
    pool: "fixture",
    owner: "owner",
    organization: "synthetic",
  });
  const request = (days?: number) =>
    f.usage.handle(
      new Request(
        `https://pool.example.test/pool/v1/usage/capacity${days === undefined ? "" : `?days=${days}`}`,
        {
          headers: { authorization: `Bearer ${token}`, [callerHeader]: "owner" },
        },
      ),
    );
  const defaultResponse = await request();
  assert.equal(defaultResponse.status, 200);
  assert.equal(
    (await defaultResponse.json()).from,
    Math.floor((at - 30 * 86400000) / 3600000) * 3600000,
  );
  const response = await request(90);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.from, Math.floor((at - 90 * 86400000) / 3600000) * 3600000);
  assert.equal(value.to, at);
  assert.equal(value.trackingSince, at);
  assert.equal(value.points.length, 2);
  assert.ok(
    value.points.every(
      (point: { hour: number }) => point.hour === Math.floor(at / 3600000) * 3600000,
    ),
  );
  assert.equal((await request(91)).status, 400);
});

test("the capacity RPC includes a measured Grok week and excludes its product breakdown", async () => {
  const at = Date.parse("2026-11-12T08:01:00Z");
  const weekly = {
    id: "xai-weekly-usage",
    label: "Weekly Limit",
    scope: "account",
    period_unit: "week",
    period_value: 1,
    mode: "fixed",
    status: "healthy",
    unit: "percentage",
    used: 2,
    remaining: 98,
    limit: 100,
    remaining_ratio: 0.98,
    observed_at: new Date(at).toISOString(),
    expires_at: new Date(at + 1800000).toISOString(),
    reset_at: new Date(at + 4 * 86400000).toISOString(),
  };
  const f = quotaSamplingFixture(at, undefined, {
    provider: "xai",
    plan: "Grok Pro",
    windows: [
      weekly,
      { ...weekly, id: "xai-product-grokchat", scope: "model", scope_id: "grokchat" },
    ],
  });
  await f.usage.observe();
  const token = await signPoolToken("ab".repeat(32), {
    pool: "fixture",
    owner: "owner",
    organization: "synthetic",
  });
  const response = await f.usage.handle(
    new Request("https://pool.example.test/pool/v1/usage/capacity?days=7", {
      headers: { authorization: `Bearer ${token}`, [callerHeader]: "owner" },
    }),
  );
  assert.equal(response.status, 200);
  const value = await f.capacity(Math.floor((at - 7 * 86400000) / 3600000) * 3600000, at);
  assert.deepEqual(await response.json(), value);
  assert.equal(value.points.length, 1);
  const point = value.points[0]!;
  assert.equal(point.provider, "xai");
  assert.equal(point.windowSeconds, 604800);
  assert.equal(point.last.accountCount, 1);
  assert.equal(point.last.remaining, 0.98);
  assert.ok(value.forecasts.some((forecast) => forecast.provider === "xai"));
  assert.equal(
    f.calls.some((route) => route.endsWith("/collect")),
    false,
  );
});

async function sampledCapacity(options: {
  sourceMinutes: number;
  sampleMinutes?: number;
  durationMinutes?: number;
  interrupt?: "membership" | "collection";
  resumeOutage?: boolean;
}) {
  const start = Date.parse("2026-11-09T08:00:00Z");
  const f = quotaSamplingFixture(start);
  const token = await signPoolToken("ab".repeat(32), {
    pool: "fixture",
    owner: "owner",
    organization: "synthetic",
  });
  const interval = options.sourceMinutes * 60_000;
  for (
    let elapsed = 0;
    elapsed <= (options.durationMinutes ?? 210) * 60_000;
    elapsed += (options.sampleMinutes ?? 5) * 60_000
  ) {
    if (options.resumeOutage && elapsed > 0 && elapsed < 20 * 60_000) continue;
    const sequence = Math.floor(elapsed / interval);
    const sourceAt = start + sequence * interval;
    const observedAt = new Date(sourceAt).toISOString();
    f.detail.collection.observed_at = observedAt;
    f.credential.observed_at = observedAt;
    if (options.interrupt === "membership") f.select(elapsed !== 10 * 60_000);
    f.detail.collection.status =
      options.interrupt === "collection" && elapsed === 10 * 60_000 ? "failed" : "success";
    for (const window of f.detail.windows) {
      window.observed_at = observedAt;
      window.expires_at = new Date(sourceAt + 30 * 60_000).toISOString();
      window.remaining = 90 - sequence;
      window.remaining_ratio = window.remaining / 100;
    }
    await f.sampleAt(start + elapsed);
  }
  const response = await f.usage.handle(
    new Request("https://pool.example.test/pool/v1/usage/capacity?days=7", {
      headers: { authorization: `Bearer ${token}`, [callerHeader]: "owner" },
    }),
  );
  assert.equal(response.status, 200);
  const value = await response.json();
  const forecast = value.forecasts.find(
    (entry: { windowSeconds: number }) => entry.windowSeconds === 604800,
  );
  assert.ok(forecast, "the weekly quota remains visible");
  assert.equal(
    f.calls.some((route) => route.endsWith("/collect")),
    false,
  );
  return forecast;
}

test("automatic half-hour quota observations train capacity despite collection jitter", async () => {
  for (const sourceMinutes of [30.03, 34.04]) {
    const forecast = await sampledCapacity({ sourceMinutes });
    assert.ok(
      forecast.history.observedHours >= 2,
      `${sourceMinutes}-minute source cadence must train completed hours`,
    );
  }
});

test("weekly training rejects long source intervals and sampler outages", async () => {
  for (const options of [{ sourceMinutes: 35.01 }, { sourceMinutes: 34.04, sampleMinutes: 20 }]) {
    const forecast = await sampledCapacity(options);
    assert.equal(forecast.history.observedHours, 0);
  }
});

test("removing an account or failing collection breaks historical source continuity", async () => {
  const uninterrupted = await sampledCapacity({ sourceMinutes: 34.04, durationMinutes: 75 });
  assert.equal(uninterrupted.history.observedHours, 1);
  for (const interrupt of ["membership", "collection"] as const) {
    const forecast = await sampledCapacity({
      sourceMinutes: 34.04,
      durationMinutes: 75,
      interrupt,
    });
    assert.equal(forecast.history.observedHours, 0, interrupt);
  }
});

test("a resumed sampler cannot train across its earlier outage", async () => {
  const forecast = await sampledCapacity({
    sourceMinutes: 34.04,
    durationMinutes: 75,
    resumeOutage: true,
  });
  assert.equal(forecast.history.observedHours, 0);
});
