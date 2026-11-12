import assert from "node:assert/strict";
import { test } from "node:test";
import { reportWhenDue, reportingCadence } from "./reporting.ts";

test("failed reporting backs off without suppressing other reports or restarting after eviction", async () => {
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
  };
  let failed = 0,
    healthy = 0;
  const broken = async () => {
    failed++;
    throw new Error("fixture outage");
  };
  await assert.rejects(reportWhenDue(storage, "usage", broken, 0), /fixture outage/);
  await reportWhenDue(
    storage,
    "history",
    async () => {
      healthy++;
    },
    0,
  );
  for (let at = 5_000; at < reportingCadence; at += 5_000)
    await reportWhenDue({ ...storage }, "usage", broken, at);
  assert.deepEqual({ failed, healthy }, { failed: 1, healthy: 1 });
  await assert.rejects(reportWhenDue(storage, "usage", broken, reportingCadence), /fixture outage/);
  assert.equal(failed, 2);
});
