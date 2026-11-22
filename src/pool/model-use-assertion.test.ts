import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import { modelMembership } from "./model-membership.ts";
import {
  membershipTtlMs,
  modelUseAssertionTtlMs,
  policyHeader,
  policyUsePrefix,
} from "./membership-contract.ts";
import { openEnvelope } from "./token.ts";
import {
  membershipGraceFixture as fixture,
  membershipSigningKey as key,
} from "../../scripts/pool-tests/membership-grace-fixture.ts";

const units = { Hour: 3_600_000, Minute: 60_000, Second: 1_000, Millisecond: 1 } as const;

/** The verifier's caps live in the plugin source; read them so the two sides cannot drift apart. */
function nativeCapMs(name: string) {
  const source = readFileSync(
    new URL("../../containers/pool/native_policy/policy.go", import.meta.url),
    "utf8",
  );
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(\\d+)\\s*\\*\\s*time\\.(Hour|Minute|Second|Millisecond)\\b`,
  ).exec(source);
  assert.ok(match, `${name} is declared as N * time.Unit in policy.go`);
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

/** Mirrors the plugin's window check (policy.go evaluatePick) for a verifier clock `skewMs` behind the signer. */
function acceptedBehind(expiresAt: number, signerNow: number, skewMs: number, capMs: number) {
  const remaining = expiresAt - (signerNow - skewMs);
  return remaining > 0 && remaining <= capMs;
}

test("Worker TTLs stay strictly below the native caps with clock-skew headroom", () => {
  const assertionCap = nativeCapMs("maxAssertionTTL");
  const projectionCap = nativeCapMs("maxProjectionTTL");
  assert.ok(assertionCap - modelUseAssertionTtlMs >= 5 * 60_000);
  assert.ok(projectionCap - membershipTtlMs >= 1_000);
});

test("a freshly minted model-use assertion passes the native cap when the pool clock runs behind", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  const before = Date.now();
  const gate = await modelMembership(
    new Request("https://pool.invalid/v1/responses", { method: "POST" }),
    memberships,
    key,
    undefined,
    f.streams,
    { pool: "pool", person: "person" },
  );
  const after = Date.now();
  gate.lease?.release();
  const claims = (await openEnvelope(
    key,
    policyUsePrefix,
    gate.request.headers.get(policyHeader)!,
  )) as { expiresAt: number };
  assert.ok(claims.expiresAt >= before + modelUseAssertionTtlMs);
  assert.ok(claims.expiresAt <= after + modelUseAssertionTtlMs);
  const cap = nativeCapMs("maxAssertionTTL");
  // `before` is the earliest signer instant, so it is the worst case for a verifier running behind.
  for (const skewMs of [0, 5, 50, 4 * 60_000])
    assert.ok(
      acceptedBehind(claims.expiresAt, before, skewMs, cap),
      `accepted ${skewMs} ms behind`,
    );
});
