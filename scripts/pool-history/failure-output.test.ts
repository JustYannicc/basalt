import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { redactFailureOutput } from "./failure-output.ts";

const key = "ab".repeat(32);
const claims = (expiresAt: number) => ({
  user: "person-a",
  grant: "native:grant-a",
  computer: "computer-a",
  pool: "pool-a",
  method: "POST",
  path: "/v1/chat/completions",
  expiresAt,
});

test("hyphenated envelope prefixes are redacted whole too", () => {
  for (const prefix of ["sb-app-model1", "sbm-policy1", "sbm-use1"]) {
    const envelope = `${prefix}.eyJwb29sIjoicCJ9.c2lnbmF0dXJlLXdpdGhvdXQtZGlnaXRz`;
    assert.equal(redactFailureOutput(`failed ${envelope}`, {}), "failed [redacted]");
  }
});

/**
 * The first expiry whose signature holds no digit: a long run without one is not caught by the
 * letters-and-digits rule, and the signature with a guessable payload is the whole assertion.
 */
async function digitFreeAssertion() {
  let expiresAt = 1_800_000_000_000;
  let assertion = await signEnvelope(key, nativeModelPrefix, claims(expiresAt));
  while (/\d/u.test(assertion.split(".")[2]!) && expiresAt < 1_800_000_010_000)
    assertion = await signEnvelope(key, nativeModelPrefix, claims(++expiresAt));
  assert.doesNotMatch(assertion.split(".")[2]!, /\d/u, "a digit-free signature within the bound");
  return assertion;
}

test("a signed assertion inside failure text never survives redaction, whole or in part", async () => {
  const assertion = await digitFreeAssertion();
  for (const text of [
    `request failed: x-basalt-native-assertion: ${assertion}`,
    `{"headers":{"x-basalt-native-assertion":"${assertion}"}}`,
    `failed ${assertion}\nnext line`,
  ]) {
    const redacted = redactFailureOutput(text, {});
    for (const part of assertion.split(".").slice(1))
      assert.ok(!redacted.includes(part), `${part} survived in ${redacted}`);
    assert.match(redacted, /\[redacted\]/u);
  }
});

test("an envelope stuck to a word, URL-encoded, or cut short at either end is still redacted", async () => {
  const assertion = await digitFreeAssertion();
  const [, payload, signature] = assertion.split(".") as [string, string, string];
  for (const text of [
    `assertion%3D${assertion}`,
    `token_${assertion}`,
    `headers=x${assertion}&next=1`,
    // A tail cut inside the prefix, or with the prefix gone.
    assertion.slice(3),
    `failed: ${payload}.${signature}`,
    // Cut inside the payload, or inside the signature.
    `failed: ${payload.slice(7)}.${signature} next`,
    `failed: ${payload}.${signature.slice(0, 20)}`,
  ]) {
    const redacted = redactFailureOutput(text, {});
    for (const part of [payload.slice(7), signature.slice(0, 20)])
      assert.ok(!redacted.includes(part), `${part} survived in ${redacted}`);
    assert.match(redacted, /\[redacted\]/u);
  }
});
