import assert from "node:assert/strict";
import { test } from "node:test";
import { sealManifest, openManifest } from "./manifest.ts";

test("cleanup artifacts expose no manifest data and bind decryption to the exact PR", () => {
  const key = "ab".repeat(32), contents = Buffer.from('{"opaque":"private-resource-fixture"}');
  const sealed = sealManifest(contents, key, 17);
  assert.ok(!sealed.includes(contents));
  assert.ok(!sealed.includes("private-resource-fixture"));
  assert.deepEqual(openManifest(sealed, key, 17), contents);
  assert.notDeepEqual(sealManifest(contents, key, 17), sealed);
  assert.throws(() => openManifest(sealed, key, 18), /authentication failed/);
  assert.throws(() => openManifest(sealed, "cd".repeat(32), 17), /authentication failed/);
  const modified = JSON.parse(sealed.toString()); modified.ciphertext = "corrupt";
  assert.throws(() => openManifest(Buffer.from(JSON.stringify(modified)), key, 17), /authentication failed/);
  assert.throws(() => openManifest(Buffer.from("bad-private-fixture"), key, 17), {
    message: "Preview cleanup manifest authentication failed",
  });
});

test("a PR and a rehearsal of the same number cannot open each other's cleanup manifest", () => {
  const key = "ab".repeat(32), contents = Buffer.from('{"opaque":"private-resource-fixture"}');
  const rehearsal = { kind: "rehearsal", number: 17 } as const;
  const sealedPr = sealManifest(contents, key, 17);
  const sealedRehearsal = sealManifest(contents, key, rehearsal);
  assert.deepEqual(openManifest(sealedRehearsal, key, rehearsal), contents);
  assert.deepEqual(Object.keys(JSON.parse(sealedPr.toString())), ["version", "pullRequest", "iv", "tag", "ciphertext"]);
  assert.throws(() => openManifest(sealedPr, key, rehearsal), /authentication failed/);
  assert.throws(() => openManifest(sealedRehearsal, key, 17), /authentication failed/);
  // Relabelling the envelope does not help: the key and AAD differ too.
  const relabelled = JSON.parse(sealedRehearsal.toString());
  relabelled.pullRequest = relabelled.rehearsal; delete relabelled.rehearsal;
  assert.throws(() => openManifest(Buffer.from(JSON.stringify(relabelled)), key, 17), /authentication failed/);
  const relabelledPr = JSON.parse(sealedPr.toString());
  relabelledPr.rehearsal = relabelledPr.pullRequest; delete relabelledPr.pullRequest;
  assert.throws(() => openManifest(Buffer.from(JSON.stringify(relabelledPr)), key, rehearsal), /authentication failed/);
});
