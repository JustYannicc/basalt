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
    "model-history",
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

test("sixty authority ticks emit one content-free run event and no skipped noise", async () => {
  const values = new Map<string, number>(),
    events: unknown[] = [];
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, Number(value));
    },
  };
  let runs = 0;
  for (let at = 0; at < reportingCadence; at += 5000)
    await reportWhenDue(
      storage,
      "usage",
      async (progress) => {
        runs++;
        progress.rows = 17;
      },
      at,
      { report: (event) => events.push(event), clock: () => 42 },
    );
  assert.equal(runs, 1);
  assert.deepEqual(events, [
    { job: "usage", state: "ran", durationMs: 0, rows: 17, outcome: "success" },
  ]);
  await assert.rejects(
    reportWhenDue(
      storage,
      "usage",
      async () => {
        throw new Error("private fixture payload");
      },
      reportingCadence,
      { report: (event) => events.push(event), clock: () => 99 },
    ),
    /private fixture/,
  );
  assert.deepEqual(events[1], {
    job: "usage",
    state: "ran",
    durationMs: 0,
    rows: null,
    outcome: "failure",
  });
  assert.equal(JSON.stringify(events).includes("private"), false);
  await reportWhenDue(
    storage,
    "model-history",
    async (progress) => {
      progress.rows = 0;
    },
    reportingCadence,
    {
      report: () => {
        throw new Error("broken logger");
      },
    },
  );
});
