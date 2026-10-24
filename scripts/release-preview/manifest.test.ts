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
