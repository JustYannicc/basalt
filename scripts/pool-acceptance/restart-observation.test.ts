import assert from "node:assert/strict";
import test from "node:test";
import { PoolAcceptanceClient } from "./client.ts";
import { observeRestart } from "./restart-observation.ts";

test("restart observation waits after each probe and reports elapsed observation bounds", async () => {
  let now = 1_000;
  let reads = 0;
  const logs: string[] = [];
  const client = new PoolAcceptanceClient({
    origin: "https://fixture.invalid",
    now: () => now,
    fetch: async () => {
      reads += 1;
      now += 400;
      if (reads === 2) return new Response("warming", { status: 503 });
      const boot = reads === 1 ? "old-boot" : "new-boot";
      return Response.json({ data: [{ id: "fixture-model" }] }, {
        headers: { "X-Signalbox-Pool-Boot": boot },
      });
    },
  });
  const result = await observeRestart({
    client,
    apiKey: "fixture-key",
    model: "fixture-model",
    baseline: { boot: "old-boot", ids: ["fixture-model"], completedAt: now },
    options: {
      now: () => now,
      delay: async (ms) => { now += ms; },
      windowMs: 10_000,
      pollDelayMs: 2_000,
      probeTimeoutMs: 1_000,
      log: (message) => logs.push(message),
    },
  });
  assert.deepEqual(result, { boot: "new-boot" });
  assert.equal(reads, 3);
  assert.ok(logs.some((line) => line.includes("first_unavailable_status=503")));
  assert.ok(logs.some((line) => line.includes("first_failure_to_first_200_ms=2400")));
  assert.ok(logs.some((line) => line.includes("min_ms=2400 max_ms=2400")));
  assert.ok(logs.some((line) => line.includes("new_boot_catalog_observation_elapsed_ms=7200")));
  assert.ok(logs.every((line) => !line.includes("restart_duration")));
});

test("restart observation stops on authorization errors instead of treating them as downtime", async () => {
  let reads = 0;
  const client = new PoolAcceptanceClient({
    origin: "https://fixture.invalid",
    fetch: async () => {
      reads += 1;
      return new Response("unauthorized", { status: 401 });
    },
  });
  await assert.rejects(observeRestart({
    client,
    apiKey: "wrong-key",
    model: "fixture-model",
    baseline: { boot: "old-boot", ids: ["fixture-model"], completedAt: 0 },
    options: {
      now: () => 1,
      delay: async () => undefined,
      windowMs: 10_000,
      pollDelayMs: 1_000,
    },
  }), /\/v1\/models returned HTTP 401/);
  assert.equal(reads, 1);
});
