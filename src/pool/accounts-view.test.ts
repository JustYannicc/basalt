import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsView, HomeClient } from "./control.ts";
import { capacity, orderedWindows } from "../../apps/pool/ui/usage.ts";
import type { Json } from "./json.ts";

const observedAt = "2026-10-24T11:00:00Z";
const nextReadAt = "2026-10-24T11:05:00Z";
const resetAt = "2026-10-24T14:00:00Z";
function window(id: string, seconds: number, scope = "account", scopeId: string | null = null) {
  return { id, scope, scope_id: scopeId, window_seconds: seconds, remaining_ratio: 0.8,
    reset_at: resetAt, observed_at: observedAt, status: "healthy", is_unlimited: false };
}
function detail(overrides: Json = {}): Json {
  return { credential: { credential_id: "a", earliest_reset_at: resetAt, plan: { name: "Plus" } },
    collection: { freshness: "fresh", status: "success", observed_at: observedAt, next_probe_at: nextReadAt },
    windows: [], reset_credits: null, ...overrides };
}
function view(reading: Json, provider = "codex") {
  return accountsView([{ id: "a", provider, email: "synthetic@example.test" }], [reading], new Set(["a"]))[0]!;
}

test("Codex details retain 5h, weekly and real model families; capacity still reads the account week", () => {
  const result = view(detail({ windows: [
    window("codex-1-week", 604800, "account", null),
    window("codex-code-review-1-week", 604800, "model", "codex_code_review"),
    { ...window("codex-bengalfox-1-week", 604800, "model", "codex_bengalfox"), remaining_ratio: 0.1, label: "Spark" },
    window("codex-5-hour", 18000),
    window("codex-bengalfox-5-hour", 18000, "model", "codex_bengalfox"),
    window("codex-custom-1-week", 604800, "model", "codex_custom"),
    window("unrelated", 604800, "project", "unrelated"),
    { ...window("unlimited", 604800), is_unlimited: true },
    window("monthly", 2592000),
  ], reset_credits: { available_count: 3, credits: [
    { status: "available", expires_at: "2026-11-03T00:00:00Z" },
    { status: "consumed", expires_at: "2026-10-25T00:00:00Z" },
    { status: "available", expires_at: "2026-11-01T00:00:00Z" },
    { status: "available", expires_at: null },
  ] } }));
  assert.deepEqual(result.windows.map((w) => w.id), ["codex-bengalfox-5-hour", "codex-5-hour", "codex-bengalfox-1-week", "codex-custom-1-week", "codex-1-week"]);
  assert.deepEqual(result.windows.map((w) => w.label), ["5h", "5h", "Spark", "Weekly", "Weekly"]);
  assert.deepEqual(orderedWindows(result.windows), result.windows);
  assert.equal(capacity([result])[0]!.left, 0.8);
  assert.equal(result.windows.at(-1)!.windowSeconds, 604800);
  assert.ok(result.windows.every((w) => w.observedAt === observedAt));
  assert.deepEqual(result.bankedResets, { available: 3, nextExpiresAt: "2026-11-01T00:00:00Z" });
  assert.equal(result.freshness, "fresh"); assert.equal(result.readingFailed, false);
  assert.equal(result.nextReadAt, nextReadAt); assert.equal(result.earliestResetAt, resetAt);
  assert.equal(result.observedAt, observedAt); assert.equal(result.plan, "Plus");
  assert.equal(result.label, "synthetic@example.test");
});

test("Claude reset grants have a count with no individual credit list or known expiration", () => {
  const result = view(detail({ windows: [window("claude-seven-day", 604800), window("claude-five-hour", 18000)],
    reset_credits: { available_count: 4, credits: [] } }), "claude");
  assert.deepEqual(result.bankedResets, { available: 4, nextExpiresAt: null });
  assert.deepEqual(result.windows.map((w) => w.windowSeconds), [18000, 604800]);
});

test("unnamed windows use their duration and hide only when neither name nor duration is known", () => {
  const windows = [
    window("raw-five-hour-id", 18_000),
    { ...window("raw-week-id", 604_800), label: "  " },
    window("raw-month-id", 2_592_000),
    window("raw-minute-id", 90),
    { ...window("raw-named-id", 0), label: "Daily allowance", window_seconds: null },
    { ...window("raw-unknown-id", 0), window_seconds: null },
    window("raw-zero-id", 0),
    window("raw-negative-id", -1),
  ];
  for (const reading of [detail({ windows }), { credential_id: "a", primary_windows: windows }]) {
    const result = view(reading, "other");
    assert.deepEqual(result.windows.map((w) => w.label), ["90s", "5h", "Weekly", "30d", "Daily allowance"]);
    assert.ok(result.windows.every((w) => !w.label.startsWith("raw-")));
  }
});

test("stale and failed readings keep last-known windows; partial is usable, never is explicit", () => {
  for (const [freshness, status, failed] of [["stale", "failed", true], ["never", "failed", true], ["fresh", "partial", false], ["never", "unsupported", false]] as const) {
    const result = view(detail({ collection: { freshness, status, observed_at: observedAt, next_probe_at: nextReadAt },
      windows: [{ ...window("codex-5-hour", 18000), observed_at: "2026-10-24T10:00:00Z" }] }));
    assert.equal(result.freshness, freshness); assert.equal(result.readingFailed, failed);
    assert.equal(result.windows[0]!.observedAt, "2026-10-24T10:00:00Z");
    assert.equal(result.nextReadAt, nextReadAt); assert.equal(result.bankedResets, null);
  }
  assert.equal(view(detail({ reset_credits: undefined })).bankedResets, null);
  assert.deepEqual(view(detail({ reset_credits: { available_count: 0, credits: [] } })).bankedResets, { available: 0, nextExpiresAt: null });
  const empty = accountsView([{ id: "a" }], [], new Set(["a"]))[0]!;
  assert.equal(empty.freshness, "never"); assert.equal(empty.nextReadAt, null); assert.equal(empty.earliestResetAt, null);
});

test("quota detail reads are bounded to four, preserve ids and never call the list endpoint", async () => {
  let active = 0, peak = 0;
  const calls: string[] = [];
  const client = new HomeClient(async (path) => {
    calls.push(path); active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve)); active--;
    const id = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    return Response.json({ credential: { credential_id: id }, windows: [], collection: { freshness: "never" }, reset_credits: null });
  });
  const ids = ["a/b", ...Array.from({ length: 9 }, (_, i) => `a-${i}`)];
  const result = await client.quota([...ids, ids[0]!], true);
  assert.equal(peak, 4); assert.equal(active, 0); assert.equal(calls.length, ids.length);
  assert.deepEqual(result.map((row) => (row.credential as Json).credential_id), ids);
  assert.ok(calls.every((path) => path.includes("/quota/credentials/") && !path.includes("?")));
});

test("quota detail cache shares in-flight reads and expires at the earlier of next probe or 60 seconds", async () => {
  let now = 1_000, calls = 0;
  const gate = deferred<void>();
  const client = new HomeClient(async () => {
    calls++;
    if (calls === 1) await gate.promise;
    return Response.json({ credential: { credential_id: "a" }, collection: { next_probe_at: new Date(120_000).toISOString() }, windows: [] });
  }, () => now);
  const first = client.quota(["a"], true), second = client.quota(["a"], true);
  assert.equal(calls, 1);
  gate.resolve();
  await Promise.all([first, second]);
  now = 60_999; await client.quota(["a"], true);
  assert.equal(calls, 1);
  now = 61_000; await client.quota(["a"], true);
  assert.equal(calls, 2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
