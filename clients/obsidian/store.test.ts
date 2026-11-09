import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./store.ts";
import type { SyncState } from "./types.ts";

const head = "a".repeat(40);
const state = (pending: boolean): SyncState => ({
  version: 1,
  importId: "import-1",
  head,
  files: {},
  pending: pending
    ? {
        kind: "apply",
        request: { base: head, operation: "sync-1", edits: [{ path: "n.md", content: "x" }] },
        sent: { "n.md": "b".repeat(40) },
        attempts: 1,
      }
    : null,
  conflicts: [],
  unsupported: [],
});

test("writes run one at a time and a later pin write can't drop a queued operation", async () => {
  let disk: unknown = null,
    inFlight = 0,
    overlap = false,
    gated = false;
  const gates: (() => void)[] = [];
  const store = await openStore(
    {
      load: async () => disk,
      save: async (data) => {
        inFlight++;
        if (inFlight > 1) overlap = true;
        if (gated) await new Promise<void>((resolve) => gates.push(resolve));
        disk = data;
        inFlight--;
      },
    },
    () => "device0001",
  );
  gated = true;

  const saved = store.states("app").save(state(true));
  const pinned = store.pins.set(["Projects"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  while (gates.length) {
    gates.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all([saved, pinned]);
  assert.equal(overlap, false);
  const reopened = await openStore({ load: async () => disk, save: async () => {} });
  assert.equal((await reopened.states("app").load())?.pending?.request.operation, "sync-1");
  assert.deepEqual(reopened.pins.get(), ["Projects"]);
  assert.equal(reopened.secretKey, "basalt-sync-device0001");
});

test("persisted state goes through decodeState and is never silently replaced", async () => {
  const disk = {
    device: "device0001",
    states: { app: { version: 1, files: { "../escape.md": {} } } },
  };
  const store = await openStore({
    load: async () => disk,
    save: async () => assert.fail("no write expected"),
  });
  await assert.rejects(store.states("app").load(), /invalid/u);
});

test("credentials never land in plugin data", async () => {
  let disk: unknown = null;
  const store = await openStore({
    load: async () => disk,
    save: async (data) => void (disk = data),
  });
  await store.states("app").save(state(false));
  await store.markSynced(1);
  assert.doesNotMatch(JSON.stringify(disk), /token|secret|verifier|device_code/iu);
});
