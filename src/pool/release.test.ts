import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { poolRelease, poolReleasePath } from "./release.ts";

const key = "ab".repeat(32);

test("the release route reports the code revision and key version, never key material", async () => {
  const response = await poolRelease(
    new Request(`https://pool.example${poolReleasePath}`),
    {
      POOL_APP_SIGNING_KEY: key,
    },
    "fixture-revision",
    async () => true,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), {
    revision: "fixture-revision",
    // The tools service records the same value as `tokenKeyVersion`.
    keyVersion: createHash("sha256").update(key).digest("hex").slice(0, 16),
    imageReady: true,
  });
  assert.ok(!text.includes(key));
  const write = await poolRelease(
    new Request(`https://pool.example${poolReleasePath}`, { method: "POST" }),
    { POOL_APP_SIGNING_KEY: key },
  );
  assert.equal(write.status, 405);
});
