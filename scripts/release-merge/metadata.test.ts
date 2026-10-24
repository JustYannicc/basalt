import assert from "node:assert/strict";
import test from "node:test";
import { removedManifestRecords } from "./metadata.ts";

const upstream = {
  file: "0008-caller-identity.patch", kind: "upstream", upstream_pull_request: 2346,
  database_sensitive: false, workflow_sensitive: true,
};
const overlay = {
  file: "0009-basalt-framework.patch", kind: "overlay", upstream_pull_request: null,
  database_sensitive: false, workflow_sensitive: false,
  remove_with: upstream.file, requires: "npm apps release with executor#2346",
};
const manifest = (patches: object[]) => JSON.stringify({
  format_version: 2, repository: "UsefulSoftwareCo/executor", patches,
});

test("an upstream merge can retire its carry while the framework overlay remains", () => {
  const result = removedManifestRecords({ base: manifest([upstream, overlay]), candidate: manifest([overlay]) });
  assert.deepEqual(result, { ok: true, reason: "", removed: [upstream.file] });
});

test("removing the framework overlay requires a separate review even with its dependency removed", () => {
  const result = removedManifestRecords({ base: manifest([upstream, overlay]), candidate: manifest([]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /separate reviewed update/);
});

test("automated removal cannot smuggle changed overlay retirement conditions", () => {
  const result = removedManifestRecords({
    base: manifest([upstream, overlay]),
    candidate: manifest([{ ...overlay, requires: "already satisfied" }]),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /only be removed/);
});

test("unknown registry fields and unpaired overlay requirements fail the merge policy", () => {
  for (const invalid of [{ ...overlay, secret: "unexpected" }, { ...overlay, remove_with: undefined }]) {
    assert.equal(removedManifestRecords({
      base: manifest([upstream, invalid]), candidate: manifest([invalid]),
    }).ok, false);
  }
});
