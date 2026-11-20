import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  membershipTtlMs,
  nativeProjectionTtlCapMs,
  policyInstallTimeoutMs,
} from "./membership-contract.ts";
import { unfenceHandBackAfterMs } from "./runtime-slots/controller.ts";

test("an unfence hands a slot back only once every grant from before its fence has ended", async () => {
  const policy = await readFile(
    new URL("../../containers/pool/native_policy/policy.go", import.meta.url),
    "utf8",
  );
  const cap = /maxProjectionTTL\s*=\s*(\d+) \* time\.Second/u.exec(policy);
  assert.ok(cap, "the plugin's projection cap moved: update nativeProjectionTtlCapMs with it");
  assert.equal(nativeProjectionTtlCapMs, Number(cap[1]) * 1_000, "the mirror follows the plugin");
  // A grant signed before the fence lives at most the cap from when the plugin took it, and an
  // install lands within its timeout; the signer's own lease is shorter than the cap.
  assert.ok(membershipTtlMs <= nativeProjectionTtlCapMs);
  assert.equal(
    unfenceHandBackAfterMs,
    Math.max(membershipTtlMs, nativeProjectionTtlCapMs) + policyInstallTimeoutMs,
  );
  assert.ok(unfenceHandBackAfterMs >= nativeProjectionTtlCapMs + policyInstallTimeoutMs);
});
