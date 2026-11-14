import assert from "node:assert/strict";
import { test } from "node:test";
import { runAvailabilityProbe } from "../pool/availability-schedule.ts";

const release = "a".repeat(40);
const env = {
  POOL_AVAILABILITY_TARGET: "fixture-pool",
  SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
};

test("cron failures retain the observed runtime and release without changing their outage classification", async (t) => {
  const events: Record<string, unknown>[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const lines = new TextDecoder().decode(init?.body as ArrayBuffer).split("\n");
    if (JSON.parse(lines[1]!).type === "event") events.push(JSON.parse(lines[2]!));
    return new Response(null, { status: 202 });
  });
  await runAvailabilityProbe(
    env,
    async () => ({
      ok: false,
      failures: [{ guard: "pool_view", reason: "unavailable" }],
      runtime: {
        source: "selected",
        running: true,
        applicationVersion: "52",
        bootId: "12345678-1234-4234-8234-123456789abc",
        expectedBootId: "87654321-4321-4321-8321-cba987654321",
        imageInput: "b".repeat(16),
      },
    }),
    undefined,
    release,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.release, release);
  assert.deepEqual(events[0]!.tags, {
    error_code: "pool_availability_failure",
    guard: "pool_view",
    reason: "unavailable",
    probe_origin: "availability_cron",
    runtime_source: "selected",
    application_version: "52",
    boot_id: "12345678-1234-4234-8234-123456789abc",
  });
  const contexts = events[0]!.contexts as { pool_probe: { runtime: unknown } };
  assert.deepEqual(contexts.pool_probe.runtime, {
    source: "selected",
    running: true,
    application_version: "52",
    boot_id: "12345678-1234-4234-8234-123456789abc",
    expected_boot_id: "87654321-4321-4321-8321-cba987654321",
    image_input: "b".repeat(16),
    image_input_source: "selected",
  });
});

test("an unreachable cron RPC still records its release and explicit missing runtime identity", async (t) => {
  let event: { release?: string; tags?: Record<string, string> } | undefined;
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const lines = new TextDecoder().decode(init?.body as ArrayBuffer).split("\n");
    if (JSON.parse(lines[1]!).type === "event") event = JSON.parse(lines[2]!);
    return new Response(null, { status: 202 });
  });
  await runAvailabilityProbe(
    env,
    async () => {
      throw new Error("private-runtime-endpoint");
    },
    undefined,
    release,
  );
  assert.equal(event?.release, release);
  assert.equal(event?.tags?.application_version, "unavailable");
  assert.equal(event?.tags?.boot_id, "unavailable");
  assert.equal(event?.tags?.runtime_source, "unavailable");
  assert.equal(event?.tags?.error_code, "pool_availability_failure");
  assert.doesNotMatch(JSON.stringify(event), /private-runtime-endpoint/);
});

test("malformed runtime identities cannot put private diagnostics into cron envelopes", async (t) => {
  const messages: string[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    messages.push(new TextDecoder().decode(init?.body as ArrayBuffer));
    return new Response(null, { status: 202 });
  });
  await runAvailabilityProbe(
    env,
    async () => ({
      ok: false,
      failures: [{ guard: "runtime", reason: "unavailable" }],
      runtime: {
        source: "legacy",
        running: false,
        applicationVersion: "private-version",
        bootId: "private-secret",
        expectedBootId: "private-expected-secret",
        imageInput: "private-image",
      },
    }),
    undefined,
    "private-release",
  );
  assert.equal(messages.length, 3);
  assert.doesNotMatch(JSON.stringify(messages), /private-/);
  const event = JSON.parse(messages[2]!.split("\n")[2]!);
  assert.equal(event.tags.error_code, "pool_availability_failure");
  assert.equal(event.tags.boot_id, "unavailable");
  assert.equal(event.release, undefined);
});
