import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTarget, noteHref, fileHref } from "./links.ts";
import { sortEntries, vaultState, type ImportStatus, type Version } from "./model.ts";

const complete: ImportStatus = { state: "complete", files: 133, confirmed: 131, omitted: 2 };
// What a vault synced by plugin 0.2.x holds on a server without dated history.
const oldPluginVersion: Version = { oid: "a1", parents: ["a0"], message: "Sync from Obsidian" };

test("a vault synced by an old plugin shows as saved, never as empty", () => {
  assert.deepEqual(vaultState({ status: complete, hasFiles: true, latest: oldPluginVersion }), {
    kind: "saved",
  });
  // Files synced outside the import still count as a vault.
  assert.deepEqual(vaultState({ status: null, hasFiles: true, latest: null }), {
    kind: "saved",
  });
});

test("a vault that never synced is the only empty state", () => {
  assert.deepEqual(vaultState({ status: null, hasFiles: false, latest: null }), { kind: "empty" });
  assert.notEqual(
    vaultState({ status: null, hasFiles: false, latest: oldPluginVersion }).kind,
    "empty",
  );
});

test("an unfinished import reads as importing, with its counts", () => {
  const status: ImportStatus = { state: "ready", files: 133, confirmed: 0, omitted: 0 };
  assert.deepEqual(vaultState({ status, hasFiles: false, latest: null }), {
    kind: "importing",
    confirmed: 0,
    files: 133,
  });
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

test("only the import and the vault decide its state: an unfinished import never reads as stuck", () => {
  // Sync records can't yet tell a device from an agent, so no state depends on them.
  const status: ImportStatus = { state: "ready", files: 133, confirmed: 0, omitted: 0 };
  assert.equal(vaultState({ status, hasFiles: false, latest: null }).kind, "importing");
  assert.equal(vaultState({ status: complete, hasFiles: true, latest: null }).kind, "saved");
});
