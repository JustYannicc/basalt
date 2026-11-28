import assert from "node:assert/strict";
import { test } from "node:test";
import { runPoolFleet, type DispatchInput } from "./dispatch.ts";
import { shortHash } from "./controller.ts";
import { colours, harness } from "./test/harness.ts";

const dispatch: DispatchInput = {
  mode: "inspect",
  go: "coordinator-2026-11-23-fleet-failure",
  ref: "refs/heads/main",
  event: "workflow_dispatch",
};
const target = (slot: number) => ({
  format: "pool-runtime-slot-v1" as const,
  controllerId: "controller",
  slotId: `runtime-cell-secret-${slot}`,
  applicationId: colours.blue.id,
  applicationVersion: "1",
  instanceId: String(slot).repeat(64),
  imageDigest: colours.blue.image,
  imageInput: colours.blue.input,
  homePeerOrdinal: slot,
});
const lease = {
  at: Date.parse("2026-11-23T12:24:04.000Z"),
  step: "endpoint_health",
  cause: "lease_elapsed",
  roundTripMs: 1_612,
  leaseLeftMs: -112,
};
const signalledAt = "2026-11-23T12:24:05.512Z";
const refused = {
  at: lease.at + 2_000,
  step: "endpoint_health",
  cause: "slot_unhealthy",
  roundTripMs: 40,
  // A key no decoder writes, as a row from a damaged store could hold: it never prints.
  ready: {
    lastLapse: { step: "plugin_probe", ms: 2_100, at: signalledAt, note: "planted-row-text" },
    lastStall: {
      lateMs: 1_640,
      cpuMs: 2,
      stealMs: 0,
      throttledMs: 1_210,
      cpus: 2,
      at: signalledAt,
    },
    lapses: 4,
    stalls: 3,
  },
};
// What the lane prints for it: every field, null where the read had none.
const printedReady = {
  lastLapse: { step: "plugin_probe", ms: 2_100, at: signalledAt },
  lastFlip: null,
  lastStall: { lateMs: 1_640, cpuMs: 2, stealMs: 0, throttledMs: 1_210, cpus: 2, at: signalledAt },
  lapses: 4,
  flips: null,
  stalls: 3,
};
const { ready: _signals, ...unsignalled } = refused;
const timeout = { ...unsignalled, at: refused.at + 6_000, cause: "timeout", roundTripMs: 2_001 };
// As the rule writes them: a late answer opens the episode, two failures 6 s apart end it.
const suspect = { since: lease.at, failed: refused, reads: [lease, refused] };
const failure = { path: "health", rule: "failed_twice", reads: [refused, timeout] };

test("the inspect lane prints each row's slot key and ordinal, its failed read, its quarantine, and why each recent cell left", async () => {
  const lane = await harness({ startCell: false });
  try {
    lane.storage.values.set("runtime-fleet-v1:resources", [
      {
        target: target(1),
        identity: { ...target(1), bootId: "boot-1" },
        phase: "ready",
        active: 0,
        lastUsedAt: 0,
        suspect,
      },
      {
        target: target(2),
        identity: { ...target(2), bootId: "boot-2" },
        phase: "quarantined",
        reason: "runtime_failed",
        active: 0,
        lastUsedAt: 0,
        failure,
      },
    ]);
    lane.storage.values.set("runtime-fleet-v1:recent-ends", [
      {
        slotId: target(3).slotId,
        end: null,
        left: "quarantined",
        reason: "runtime_failed",
        failure,
      },
      // Kept before the leave fields existed: still printed, with what it has.
      {
        slotId: target(4).slotId,
        end: { at: 1, exitCode: 0, cause: "exit", seen: "monitor", stopSent: true },
      },
    ]);
    const result = await runPoolFleet(dispatch, lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    const fleet = (result as { result: { fleet: Record<string, unknown> } }).result.fleet as {
      rows: { key: unknown; ordinal: unknown; suspect: unknown; failure: unknown }[];
      recentEnds: { key: string; left: unknown; reason: unknown; failure: unknown; end: unknown }[];
    };
    const read = (value: {
      at: number;
      step: string;
      cause: string;
      roundTripMs: number;
      leaseLeftMs?: number;
      ready?: unknown;
    }) => ({
      at: new Date(value.at).toISOString(),
      step: value.step,
      cause: value.cause,
      roundTripMs: value.roundTripMs,
      leaseLeftMs: value.leaseLeftMs ?? null,
      ready: value.ready ? printedReady : null,
    });
    // The same key a recent end carries, so a row and its later leave can be matched.
    assert.deepEqual(
      fleet.rows.map((row) => [row.key, row.ordinal]),
      [
        [shortHash(target(1).slotId), 1],
        [shortHash(target(2).slotId), 2],
      ],
    );
    assert.equal(fleet.recentEnds[0]?.key, shortHash(target(3).slotId));
    assert.deepEqual(fleet.rows[0]?.suspect, {
      since: new Date(lease.at).toISOString(),
      failed: read(refused),
      reads: [read(lease), read(refused)],
      policyOwed: 0,
    });
    assert.equal(fleet.rows[0]?.failure, null);
    assert.deepEqual(fleet.rows[1]?.failure, {
      path: "health",
      rule: "failed_twice",
      reads: [read(refused), read(timeout)],
    });
    assert.deepEqual(fleet.recentEnds[0], {
      key: fleet.recentEnds[0]?.key,
      end: null,
      left: "quarantined",
      reason: "runtime_failed",
      failure: { path: "health", rule: "failed_twice", reads: [read(refused), read(timeout)] },
    });
    assert.equal(fleet.recentEnds[1]?.left, null);
    assert.equal((fleet.recentEnds[1]?.end as { stopSent?: unknown })?.stopSent, true);
    // Slots print as short hashes only, and a read's signals as closed values only.
    assert.doesNotMatch(JSON.stringify(result), /runtime-cell-secret/u);
    assert.doesNotMatch(JSON.stringify(result), /planted-row-text/u);
  } finally {
    await lane.close();
  }
});
