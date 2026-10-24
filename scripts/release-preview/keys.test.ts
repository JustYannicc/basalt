import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePreviewSecrets, previewKey } from "./keys.ts";

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
