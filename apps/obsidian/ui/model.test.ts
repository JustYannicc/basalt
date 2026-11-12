import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTarget, noteHref, fileHref } from "./links.ts";
import {
  authorLabel,
  deviceLabels,
  sortEntries,
  stuckAfterMs,
  vaultState,
  type Devices,
  type ImportStatus,
  type Version,
} from "./model.ts";

const now = Date.parse("2026-11-12T10:00:00Z");
const complete: ImportStatus = { state: "complete", files: 133, confirmed: 131, omitted: 2 };
// What a vault synced by plugin 0.2.x holds on a server without check-ins or dated history.
const oldPluginVersion: Version = { oid: "a1", parents: ["a0"], message: "Sync from Obsidian" };

test("a vault synced by an old plugin shows as saved with its file count, never as empty", () => {
  assert.deepEqual(
    vaultState({ status: complete, hasFiles: true, latest: oldPluginVersion, devices: null, now }),
    { kind: "saved", files: 133 },
  );
  // Files synced outside the import still count as a vault.
  assert.deepEqual(vaultState({ status: null, hasFiles: true, latest: null, devices: null, now }), {
    kind: "saved",
    files: null,
  });
});

test("a vault that never synced is the only empty state", () => {
  assert.deepEqual(
    vaultState({ status: null, hasFiles: false, latest: null, devices: null, now }),
    { kind: "empty" },
  );
  assert.notEqual(
    vaultState({ status: null, hasFiles: false, latest: oldPluginVersion, devices: null, now })
      .kind,
    "empty",
  );
});

test("an unfinished import without check-ins reads as importing, with its counts", () => {
  const status: ImportStatus = { state: "ready", files: 133, confirmed: 0, omitted: 0 };
  assert.deepEqual(vaultState({ status, hasFiles: false, latest: null, devices: null, now }), {
    kind: "importing",
    confirmed: 0,
    files: 133,
  });
});

test("an unfinished import is stuck once no device has synced for ten minutes", () => {
  const status: ImportStatus = { state: "ready", files: 133, confirmed: 0, omitted: 0 };
  const synced = (ms: number): Devices => ({
    vault: { name: "Garden Notes" },
    devices: [
      {
        connection: "c1",
        agent: null,
        name: "Mac",
        lastSyncAt: new Date(now - ms).toISOString(),
        pluginVersion: "0.2.3",
      },
    ],
  });
  assert.equal(
    vaultState({ status, hasFiles: false, latest: null, devices: synced(60_000), now }).kind,
    "importing",
  );
  const stuck = vaultState({
    status,
    hasFiles: false,
    latest: null,
    devices: synced(stuckAfterMs + 1),
    now,
  });
  assert.equal(stuck.kind, "stuck");
});

test("up to date only when every device fetched the latest change", () => {
  const latest: Version = { ...oldPluginVersion, time: "2026-11-12T09:50:00Z", author: null };
  const devices = (times: (string | null)[]): Devices => ({
    vault: { name: null },
    devices: times.map((lastSyncAt, index) => ({
      connection: `c${index}`,
      agent: null,
      name: "Signalbox Obsidian Sync",
      lastSyncAt,
      pluginVersion: null,
    })),
  });
  const state = (times: (string | null)[]) =>
    vaultState({ status: complete, hasFiles: true, latest, devices: devices(times), now }).kind;
  assert.equal(state(["2026-11-12T09:55:00Z", "2026-11-12T09:50:00Z"]), "up-to-date");
  assert.equal(state(["2026-11-12T09:55:00Z", "2026-11-12T08:00:00Z"]), "behind");
  assert.equal(state(["2026-11-12T09:55:00Z", null]), "behind");
  assert.equal(state([]), "saved");
});

test("devices registered under one client name are numbered; distinct names stay", () => {
  assert.deepEqual(
    deviceLabels([
      { name: "Signalbox Obsidian Sync" },
      { name: "Signalbox Obsidian Sync" },
      { name: "Studio MacBook" },
      { name: null },
    ]),
    ["Signalbox Obsidian Sync 1", "Signalbox Obsidian Sync 2", "Studio MacBook", "Obsidian device"],
  );
});

test("history authors read plainly, and undated old commits are Unknown", () => {
  const devices: Devices = {
    vault: { name: null },
    devices: [
      { connection: "c1", agent: null, name: "Pixel phone", lastSyncAt: null, pluginVersion: null },
    ],
  };
  assert.equal(authorLabel(null, devices), "Unknown");
  assert.equal(authorLabel(undefined, null), "Unknown");
  assert.equal(authorLabel({ kind: "agent", name: "Planning agent" }, null), "Planning agent");
  assert.equal(authorLabel({ kind: "import" }, null), "Imported");
  assert.equal(authorLabel({ kind: "device", connection: "c1" }, devices), "Pixel phone");
  assert.equal(authorLabel({ kind: "device", connection: "gone" }, devices), "A device");
});

test("the tree lists folders first, then names in natural order", () => {
  const entry = (name: string, kind: "file" | "directory") => ({ name, kind });
  assert.deepEqual(
    sortEntries([
      entry("b.md", "file"),
      entry("Note 10.md", "file"),
      entry("journal", "directory"),
      entry("Note 2.md", "file"),
      entry("Attachments", "directory"),
    ]).map((item) => item.name),
    ["Attachments", "journal", "b.md", "Note 2.md", "Note 10.md"],
  );
});

test("in-page links round-trip vault paths, including spaces and unicode", () => {
  const path = "Projects/Café plan #2.md";
  assert.deepEqual(linkTarget(noteHref(path)), { kind: "note", path });
  assert.deepEqual(linkTarget(fileHref("Attachments/map 1.png")), {
    kind: "file",
    path: "Attachments/map 1.png",
  });
  assert.equal(linkTarget("https://example.com"), null);
  assert.equal(linkTarget("#note=%E0%A4%A"), null);
});
