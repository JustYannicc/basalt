import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RuntimeAuditProbe,
  auditDeadlineMs,
  homeHealthReadMs,
} from "./runtime-slots/audit-probe.ts";
import type { RuntimeConfiguration } from "./runtime-slots/configuration.ts";
import { readinessReadMs } from "./runtime-slots/forced-restart-timing.ts";
import { poolDatabase } from "./database-settings.ts";

const configuration: RuntimeConfiguration = {
  databaseUrl: "postgresql://pool.invalid/pool",
  managementKey: "management-key",
  signingKey: "signing-key",
  imageInput: "1".repeat(16),
  databaseOwner: poolDatabase.owner,
};
type Answer = { status: number; body?: unknown };
type Reply = Answer | Error | (() => Promise<Answer>);
const healthy: Record<string, Reply> = {
  "8318 /ready": { status: 503, body: { boot_id: "old-boot", started_at: "2026-11-22T00:00:00Z" } },
  "8317 /healthz": { status: 200, body: { status: "ok" } },
  "8327 /healthz": { status: 200, body: { status: "ok" } },
  "8327 /v8/management/nodes": {
    status: 200,
    body: { nodes: [{ node_id: "n", healthy: true }] },
  },
};

/** A reply that gives up when its caller's deadline does, as a container port fetch does. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal | null) {
  if (!signal) return work;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}
const after = (milliseconds: number, answer: Answer) => async () => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return answer;
};

/** Container ports answering from `replies`; the listing takes `listingMs` on the probe's clock. */
function container(
  replies: Record<string, Reply>,
  listingMs = auditDeadlineMs + 440,
  honoursAbort = true,
) {
  let clock = 0;
  const calls: string[] = [];
  const port = (number: number) => ({
    fetch: async (input: string, init?: RequestInit) => {
      const call = `${number} ${new URL(input).pathname}`;
      calls.push(call);
      const reply = replies[call] ?? { status: 404 };
      if (reply instanceof Error) throw reply;
      const answer =
        typeof reply !== "function"
          ? reply
          : await (honoursAbort ? abortable(reply(), init?.signal) : reply());
      if (call.endsWith("/v8/management/nodes")) clock += listingMs;
      return Response.json(answer.body ?? {}, { status: answer.status });
    },
  });
  return { probe: new RuntimeAuditProbe(port, () => clock), calls };
}
const signal = () => AbortSignal.timeout(5_000);
const listings = (calls: string[]) => calls.filter((call) => call.endsWith("/management/nodes"));

test("a prompt 503 whose only explanation is a listing slower than the audit's deadline is evidence", async () => {
  const { probe } = container(healthy);
  assert.deepEqual(await probe.slowAudit(configuration, "old-boot", signal()), {
    listingMs: auditDeadlineMs + 440,
  });
});

test("a listing within the audit's deadline leaves the refusal to another cause", async () => {
  const { probe } = container(healthy, auditDeadlineMs);
  assert.equal(await probe.slowAudit(configuration, "old-boot", signal()), undefined);
});

test("every read that fails, or proves another cause, is never evidence", async () => {
  const cases: [string, string, Reply][] = [
    ["readiness serves", "8318 /ready", { status: 200, body: { boot_id: "old-boot" } }],
    ["readiness names another boot", "8318 /ready", { status: 503, body: { boot_id: "new" } }],
    ["readiness doesn't answer", "8318 /ready", new Error("readiness refused")],
    ["the node's health refuses", "8317 /healthz", { status: 503, body: { status: "down" } }],
    ["the node's health doesn't answer", "8317 /healthz", new Error("node refused")],
    ["Home's health refuses", "8327 /healthz", { status: 500 }],
    ["Home's health doesn't answer", "8327 /healthz", new Error("Home refused")],
    ["the listing fails", "8327 /v8/management/nodes", { status: 500 }],
    ["the listing has no nodes", "8327 /v8/management/nodes", { status: 200, body: {} }],
    ["the listing is empty", "8327 /v8/management/nodes", { status: 200, body: { nodes: [] } }],
    [
      "the listing names no healthy node",
      "8327 /v8/management/nodes",
      { status: 200, body: { nodes: [{ node_id: "n", healthy: false }] } },
    ],
    [
      "Home's health is too slow to be database-free",
      "8327 /healthz",
      after(homeHealthReadMs + 200, { status: 200, body: { status: "ok" } }),
    ],
    ["the listing doesn't answer", "8327 /v8/management/nodes", new Error("listing timed out")],
  ];
  for (const [name, call, reply] of cases) {
    const { probe } = container({ ...healthy, [call]: reply });
    assert.equal(await probe.slowAudit(configuration, "old-boot", signal()), undefined, name);
  }
});

test("without a management key the probe reads nothing and is never evidence", async () => {
  const { probe, calls } = container(healthy);
  assert.equal(
    await probe.slowAudit({ ...configuration, managementKey: "" }, "old-boot", signal()),
    undefined,
  );
  assert.deepEqual(calls, []);
});

test("one listing at a time: a probe that finds one in flight starts no second, even after another read failed", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { probe, calls } = container({
    ...healthy,
    "8317 /healthz": new Error("node refused"),
    "8327 /v8/management/nodes": async () => {
      await pending;
      return { status: 200, body: { nodes: [] } };
    },
  });
  // The node's refusal answers the first probe while its listing is still running.
  assert.equal(await probe.slowAudit(configuration, "old-boot", signal()), undefined);
  assert.equal(await probe.slowAudit(configuration, "old-boot", signal()), undefined);
  assert.equal(listings(calls).length, 1);
  release();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await probe.slowAudit(configuration, "old-boot", signal());
  assert.equal(listings(calls).length, 2);
});

test("a peer Home is read on its own port", async () => {
  const { probe, calls } = container({
    ...healthy,
    "8329 /healthz": healthy["8327 /healthz"]!,
    "8329 /v8/management/nodes": healthy["8327 /v8/management/nodes"]!,
  });
  assert.ok(await probe.slowAudit({ ...configuration, homePeerOrdinal: 1 }, "old-boot", signal()));
  assert.ok(calls.includes("8329 /v8/management/nodes") && !calls.includes("8327 /healthz"));
});

const never = () => new Promise<Answer>(() => {});

test("a readiness read that never answers, even past its abort, gives up within its deadline", async () => {
  const { probe, calls } = container({ ...healthy, "8318 /ready": never }, undefined, false);
  const started = performance.now();
  assert.equal(await probe.slowAudit(configuration, "old-boot", signal()), undefined);
  assert.ok(performance.now() - started < readinessReadMs + 1_000);
  assert.equal(listings(calls).length, 0);
});

test("a listing that ignores its abort is given up on time and still counts as in flight", async () => {
  const { probe, calls } = container(
    { ...healthy, "8327 /v8/management/nodes": never },
    undefined,
    false,
  );
  assert.equal(
    await probe.slowAudit(configuration, "old-boot", AbortSignal.timeout(300)),
    undefined,
  );
  assert.equal(await probe.slowAudit(configuration, "old-boot", signal()), undefined);
  assert.equal(listings(calls).length, 1);
});
