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
