import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { poolWorkerRevisionModule } from "../pool-worker-revision.ts";
import {
  checkoutCode,
  codeFollower,
  probeLoop,
  refusalReason,
  rootFromActiveHealth,
  rootFromRecovery,
  summarize,
  type Sample,
  type SendResult,
} from "./stage-probe.ts";

/** A clock that only moves when a send or a sleep says so, so ticks are exact. */
function scripted(results: SendResult[], sendMs = 100) {
  let clock = 1_000;
  const stop = new AbortController();
  const sleeps: number[] = [];
  return {
    stop,
    sleeps,
    options: {
      signal: stop.signal,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      send: async () => {
        clock += sendMs;
        const next = results.shift();
        if (results.length === 0) stop.abort();
        if (!next) throw new Error("no more results");
        return next;
      },
    },
  };
}

test("the loop samples each tick at a fixed rate and stops on the signal", async () => {
  const run = scripted([
    { ok: true, rootIdentity: "a:boot-1", controllerCode: "old" },
    { ok: false, reason: "timeout" },
    { ok: true, rootIdentity: "a:boot-1", note: "root-not-ready" },
    { ok: true },
  ]);
  const streamed: Sample[] = [];
  const samples = await probeLoop({
    ...run.options,
    onSample: (sample) => void streamed.push(sample),
  });
  // The send aborted by the stop is not recorded.
  assert.deepEqual(samples, [
    { at: 1_000, ms: 100, ok: true, rootIdentity: "a:boot-1", controllerCode: "old" },
    { at: 3_000, ms: 100, ok: false, reason: "timeout" },
    { at: 5_000, ms: 100, ok: true, rootIdentity: "a:boot-1", reason: "root-not-ready" },
  ]);
  assert.deepEqual(streamed, samples);
  assert.deepEqual(run.sleeps, [1_900, 1_900, 1_900]);
});

test("a slow send shortens the next gap instead of overlapping or drifting", async () => {
  const run = scripted([{ ok: true }, { ok: true }, { ok: true }], 2_500);
  const samples = await probeLoop(run.options);
  assert.deepEqual(
    samples.map((sample) => sample.at),
    [1_000, 3_500],
  );
  assert.deepEqual(run.sleeps, [0, 0]);
});

test("a throwing send or sink costs one failed sample, never the loop", async () => {
  let calls = 0;
  const stop = new AbortController();
  const samples = await probeLoop({
    signal: stop.signal,
    intervalMs: 0,
    send: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("boom");
      if (calls === 3) stop.abort();
      return { ok: true };
    },
    onSample: () => {
      throw new Error("disk full");
    },
  });
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0], { ...samples[0], ok: false, reason: "send-threw-TypeError" });
});

test("summary spans each outage to the next success and lists root boots in order", () => {
  const samples: Sample[] = [
    { at: 0, ms: 50, ok: true, rootIdentity: "a:boot-1" },
    { at: 2_000, ms: 50, ok: false, reason: "inspect-http-503" },
    { at: 4_000, ms: 50, ok: false, reason: "timeout" },
    { at: 6_000, ms: 50, ok: false, reason: "controller-code-mismatch" },
    { at: 8_000, ms: 50, ok: true, rootIdentity: "a:boot-1" },
    { at: 10_000, ms: 50, ok: false, reason: "timeout" },
    { at: 12_000, ms: 50, ok: true, rootIdentity: "a:boot-2" },
    { at: 14_000, ms: 50, ok: true, rootIdentity: "a:boot-1" },
  ];
  assert.deepEqual(summarize(samples), {
    samples: 8,
    failures: 4,
    longestOutageMs: 6_000,
    firstFailureAt: 2_000,
    lastFailureAt: 10_000,
    rootIdentities: ["a:boot-1", "a:boot-2"],
    rootChanged: true,
  });
});

test("an outage still open at the stop closes at its last reply", () => {
  const summary = summarize([
    { at: 0, ms: 50, ok: true, rootIdentity: "a:boot-1" },
    { at: 2_000, ms: 50, ok: false, reason: "timeout" },
    { at: 4_000, ms: 300, ok: false, reason: "timeout" },
  ]);
  assert.equal(summary.longestOutageMs, 2_300);
  assert.equal(summary.rootChanged, false);
  assert.deepEqual(summarize([]), {
    samples: 0,
    failures: 0,
    longestOutageMs: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    rootIdentities: [],
    rootChanged: false,
  });
});

const oldCode = { candidate: "a".repeat(40), workerInput: "1".repeat(64) };
const newCode = { candidate: "b".repeat(40), workerInput: "2".repeat(64) };

test("the follower moves to the code that now answers, re-reading each source once per refusal", async () => {
  const reads = { checkout: 0, state: 0 };
  const follower = codeFollower([
    async () => {
      reads.checkout += 1;
      return newCode;
    },
    async () => {
      reads.state += 1;
      if (reads.state === 1) throw new Error("state unavailable");
      return oldCode;
    },
  ]);
  assert.equal(await follower.refused(), true);
  assert.deepEqual(follower.current(), newCode);
  assert.deepEqual(reads, { checkout: 1, state: 0 });
  // A stale stage refuses the checkout's code; the recorded code takes over.
  assert.equal(await follower.refused(newCode), false);
  assert.deepEqual(follower.current(), newCode);
  assert.equal(await follower.refused(newCode), true);
  assert.deepEqual(follower.current(), oldCode);
  assert.deepEqual(reads, { checkout: 3, state: 2 });
  // After the PUT the old code is refused and the checkout's answers again.
  assert.equal(await follower.refused(oldCode), true);
  assert.deepEqual(follower.current(), newCode);
  assert.deepEqual(reads, { checkout: 4, state: 2 });
});

test("only an identity refusal of inspect reads as a code mismatch", () => {
  const identity = { runtimeStep: "endpoint_route", runtimeReason: "slot_identity" };
  assert.deepEqual(refusalReason("inspect", 409, identity), {
    reason: "controller-code-mismatch",
    codeMismatch: true,
  });
  assert.deepEqual(refusalReason("active-health", 409, identity), {
    reason: "active-health-http-409-endpoint_route-slot_identity",
    codeMismatch: false,
  });
  assert.deepEqual(refusalReason("inspect", 503), {
    reason: "inspect-http-503",
    codeMismatch: false,
  });
});

test("the root identity is the fingerprinted instance and its live boot", () => {
  const instanceId = "f".repeat(64);
  const live = rootFromRecovery({ instanceId, running: true, ready: true, bootId: "boot-1" });
  assert.match(live.rootIdentity ?? "", /^[a-f0-9]{16}:boot-1$/u);
  assert.ok(!live.rootIdentity?.includes(instanceId));
  assert.deepEqual(rootFromRecovery({ instanceId, running: false, ready: false }), {
    note: "root-not-running",
  });
  assert.deepEqual(rootFromRecovery({ instanceId, running: true, ready: false }), {
    note: "root-not-ready",
  });
  assert.deepEqual(rootFromRecovery(null), { note: "root-status-unreadable" });
  const selected = rootFromActiveHealth({
    identity: { slotId: "legacy", instanceId, bootId: "boot-1" },
    leaseMs: 1,
  });
  assert.equal(selected.rootIdentity, live.rootIdentity);
  assert.deepEqual(
    rootFromActiveHealth({ identity: { slotId: "blue", instanceId, bootId: "boot-9" } }),
    { note: "selected-slot-not-root" },
  );
});

test("the checkout's code is read from its generated modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-probe-"));
  try {
    const release = join(
      root,
      ".upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts",
    );
    const revision = join(root, poolWorkerRevisionModule);
    await mkdir(dirname(release), { recursive: true });
    await mkdir(dirname(revision), { recursive: true });
    await writeFile(release, `export const productionOpsRelease = "${newCode.candidate}";\n`);
    await writeFile(revision, `export const poolWorkerRevision = "${newCode.workerInput}";\n`);
    assert.deepEqual(await checkoutCode(root), newCode);
    await writeFile(revision, `export const poolWorkerRevision = "short";\n`);
    await assert.rejects(checkoutCode(root), /no generated controller code/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
