import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceStatus } from "./controller.ts";
import { describeStatus, type StatusInput } from "./status.ts";

const idle: DeviceStatus = {
  state: "idle",
  queued: 0,
  conflicts: 0,
  unsupported: [],
  error: null,
  head: "a".repeat(40),
  importId: "i",
};
const input = (status: Partial<DeviceStatus>, extra: Partial<StatusInput> = {}): StatusInput => ({
  status: { ...idle, ...status },
  attachments: { unsynced: [], cloudOnly: 0, downloading: 0, failed: [] },
  recovered: 0,
  lastSynced: 1_000,
  now: 2_000,
  failure: null,
  ...extra,
});

test("only a clean device says synced", () => {
  const clean = describeStatus(input({}));
  assert.equal(clean.title, "Synced just now");
  assert.equal(clean.complete, true);
  for (const dirty of [
    input({ state: "attention", unsupported: ["photo.png"] }),
    input({ state: "conflict", conflicts: 1 }),
    input({}, { recovered: 2 }),
    input(
      {},
      {
        attachments: {
          unsynced: [],
          cloudOnly: 0,
          downloading: 0,
          failed: [{ path: "a.pdf", reason: "too large" }],
        },
      },
    ),
  ]) {
    const view = describeStatus(dirty);
    assert.equal(view.complete, false);
    assert.doesNotMatch(view.title, /^Synced/u);
  }
});

test("an unfinished import never reports synced and retains confirmed progress after interruption", () => {
  for (const state of ["idle", "syncing", "offline", "attention", "conflict", "paused"] as const) {
    const view = describeStatus(
      input({
        state,
        initial: { phase: "ready", files: 10, bytes: 12345, confirmed: 2 },
        ...(state === "offline" ? { error: "Connection interrupted" } : {}),
      }),
    );
    assert.equal(view.complete, false);
    assert.doesNotMatch(view.title, /synced/iu);
    assert.match(view.detail, /2 of 10 files/iu);
  }
});

test("unsynced files are named honestly, not as fully synced", () => {
  const view = describeStatus(input({ state: "attention", unsupported: ["photo.png", "doc.pdf"] }));
  assert.equal(view.title, "Needs attention");
  assert.match(view.detail, /2 files not in Basalt yet/u);
});

test("each lifecycle state has its own truthful headline", () => {
  const title = (status: Partial<DeviceStatus>) => describeStatus(input(status)).title;
  assert.equal(title({ state: "disconnected" }), "Not connected");
  assert.equal(title({ state: "authorizing" }), "Waiting for approval");
  assert.equal(title({ state: "paused", queued: 3 }), "Sync paused");
  assert.equal(title({ state: "syncing", head: null }), "Importing this vault");
  assert.equal(title({ state: "syncing" }), "Syncing");
  assert.equal(title({ state: "offline", error: "fetch failed", queued: 2 }), "Sync stopped");
  assert.equal(
    title({
      state: "offline",
      error: "Device access was removed or expired. Reconnect in Basalt.",
    }),
    "Device access ended",
  );
  assert.match(
    describeStatus(input({ state: "offline", error: "x", queued: 2 })).detail,
    /2 changes waiting/u,
  );
});
