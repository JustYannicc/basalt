import assert from "node:assert/strict";
import { test } from "node:test";
import { signEnvelope, signPoolToken, verifyPoolToken } from "./token.ts";

const current = "ab".repeat(32);
const previous = "cd".repeat(32);
const claims = { pool: "fake-pool", owner: "fake-owner", organization: "fake-org" };

test("pool tokens carry a SHA-256 key id and return the original claims", async () => {
  const token = await signPoolToken(current, claims);
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { kid: string };
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(current, "hex"))).toString("hex");
  assert.equal(payload.kid, digest.slice(0, 8));
  assert.deepEqual(await verifyPoolToken(current, token), claims);
});

test("current, previous and legacy tokens verify through a rotation", async () => {
  for (const key of [current, previous]) {
    const token = await signPoolToken(key, claims);
    assert.deepEqual(await verifyPoolToken(current, token, previous), claims);
    const legacy = await signEnvelope(key, "sbp1", claims);
    assert.deepEqual(await verifyPoolToken(current, legacy, previous), claims);
  }
  assert.equal(await verifyPoolToken(current, await signPoolToken(previous, claims)), undefined);
});

test("a key id never bypasses signature verification or accepts an unknown key", async () => {
  const token = await signPoolToken(previous, claims);
  const parts = token.split(".");
  const currentToken = await signPoolToken(current, claims);
  parts[1] = currentToken.split(".")[1]!;
  assert.equal(await verifyPoolToken(current, parts.join("."), previous), undefined);
  const unknown = await signEnvelope(current, "sbp1", { ...claims, kid: "00000000" });
  assert.equal(await verifyPoolToken(current, unknown, previous), undefined);
  assert.equal(await verifyPoolToken(current, `${currentToken}x`, previous), undefined);
});
