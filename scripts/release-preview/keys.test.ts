import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { derivePreviewSecrets, deriveStageSecrets, previewKey, stageKey } from "./keys.ts";

test("preview keys stay stable for cleanup while differing by PR, key and purpose", () => {
  const key = "ab".repeat(32);
  const a = derivePreviewSecrets(key, 17), b = derivePreviewSecrets(key, 18);
  assert.deepEqual(derivePreviewSecrets(key, 17), a);
  assert.equal(new Set(Object.values(a)).size, Object.values(a).length);
  assert.equal(a.POOL_APP_SIGNING_KEY_PREVIOUS, undefined);
  for (const [name, value] of Object.entries(a)) {
    assert.match(value!, /^[a-f0-9]{64}$/);
    assert.notEqual(value, key);
    assert.notEqual(value, b[name]);
    assert.notEqual(value, derivePreviewSecrets("cd".repeat(32), 17)[name]);
  }
  assert.throws(() => previewKey("bad-key", 17, "test"), /Invalid preview/);
  assert.throws(() => previewKey(key, 0, "test"), /Invalid preview/);
});

test("PR keys keep their original derivation and a rehearsal of the same number shares none", () => {
  const key = "ab".repeat(32);
  const original = createHmac("sha256", Buffer.from(key, "hex"))
    .update("basalt-preview-v1\u000017\u0000POOL_DEPLOYMENT_KEY").digest("hex");
  assert.equal(previewKey(key, 17, "POOL_DEPLOYMENT_KEY"), original);
  assert.equal(stageKey(key, { kind: "pr", number: 17 }, "POOL_DEPLOYMENT_KEY"), original);
  const rehearsal = stageKey(key, { kind: "rehearsal", number: 17 }, "POOL_DEPLOYMENT_KEY");
  assert.match(rehearsal, /^[a-f0-9]{64}$/);
  assert.notEqual(rehearsal, original);

  const pr = derivePreviewSecrets(key, 17);
  const rehearsalSecrets = deriveStageSecrets(key, { kind: "rehearsal", number: 17 });
  assert.deepEqual(Object.keys(rehearsalSecrets), Object.keys(pr));
  const prValues = new Set(Object.values(pr));
  for (const value of Object.values(rehearsalSecrets)) assert.ok(!prValues.has(value));
  assert.throws(() => stageKey(key, { kind: "rehearsal", number: 0 }, "test"), /Invalid preview/);
});
