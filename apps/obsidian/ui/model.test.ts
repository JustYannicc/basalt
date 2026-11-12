import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTarget, noteHref, fileHref } from "./links.ts";
import {
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

test("a vault synced by an old plugin shows as saved, never as empty", () => {
  assert.deepEqual(
    vaultState({ status: complete, hasFiles: true, latest: oldPluginVersion, devices: null, now }),
    { kind: "saved" },
  );
  // Files synced outside the import still count as a vault.
  assert.deepEqual(vaultState({ status: null, hasFiles: true, latest: null, devices: null, now }), {
    kind: "saved",
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
    head: "h1",
    lastChangeAt: null,
    devices: [{ agent: "g-mac", lastSyncAt: new Date(now - ms).toISOString(), lastHead: "h0" }],
  });
  assert.equal(
    vaultState({ status, hasFiles: false, latest: null, devices: synced(60_000), now }).kind,
    "importing",
  );
  // Right after recording starts there is no record yet: still importing, never stuck.
  assert.equal(
    vaultState({
      status,
      hasFiles: false,
      latest: null,
      devices: { head: "h1", lastChangeAt: null, devices: [] },
      now,
    }).kind,
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

test("up to date only when every syncing caller holds the current head", () => {
  const latest: Version = { ...oldPluginVersion, time: "2026-11-12T09:50:00Z" };
  const devices = (heads: string[]): Devices => ({
    head: "h2",
    lastChangeAt: "2026-11-12T09:50:00Z",
    devices: heads.map((lastHead, index) => ({
      agent: `g${index}`,
      lastSyncAt: "2026-11-12T09:55:00Z",
      lastHead,
    })),
  });
  const state = (heads: string[]) =>
    vaultState({ status: complete, hasFiles: true, latest, devices: devices(heads), now }).kind;
  assert.equal(state(["h2", "h2"]), "up-to-date");
  // A device (or an agent using the tools) that hasn't fetched the head withholds the claim.
  assert.equal(state(["h2", "h1"]), "saved");
  // No sync recorded since the release: nothing to claim either way.
  assert.equal(state([]), "saved");
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
