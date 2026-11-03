import assert from "node:assert/strict";
import { test } from "node:test";
import { startPoolFixture } from "./recipes/pool-fixture.mjs";
import { signPoolToken } from "../src/pool/token.ts";

const key = "ab".repeat(32);
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
async function fixture(t, provider = "codex") {
  const f = await startPoolFixture(key);
  t.after(() => f.stop());
  f.seedReset("pool", "synthetic-account", provider);
  const token = await signPoolToken(key, { pool: "pool", owner: "owner", organization: "org" });
  const call = async (action, payload, caller = "owner") => {
    const response = await fetch(`${f.origin}/pool/v1/accounts/synthetic-account/${action}`, {
      method: payload ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "x-signalbox-caller": caller },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  const use = (requestId = first) =>
    call("resets/use", { requestId, creditId: "synthetic-credit-1" });
  return {
    f,
    call,
    use,
    consumes: () => f.resets.calls.filter((call) => call.action === "consume"),
  };
}

test("the synthetic fixture drives pending, lost-reply recovery and same-ID replay through the real control API", async (t) => {
  const { f, call, use, consumes } = await fixture(t);
  const catalog = await call("resets");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.value.credits[0].usableNow, null);
  assert.equal(consumes().length, 0);
  f.resets.mode("synthetic-account", "unknown");
  const held = f.resets.hold();
  const pending = use();
  await held.started;
  assert.equal(consumes().length, 1);
  held.release();
  assert.equal((await pending).value.outcome, "unknown");
  f.restart();
  const attempt = await call("resets/attempt");
  assert.equal(attempt.value.requestId, first);
  assert.equal(attempt.value.canRetryProvider, true);
  assert.equal(consumes().length, 1);
  assert.equal((await use(second)).status, 409);
  assert.equal((await use()).value.outcome, "already_redeemed");
  assert.equal(f.resets.remaining("synthetic-account"), 1);
  assert.deepEqual(
    consumes().map((call) => call.requestId),
    [first, first],
  );
  await use();
  assert.equal(consumes().length, 2);
});

test("the synthetic fixture preserves expired unknowns and never contacts the provider for a member", async (t) => {
  const { f, call, use, consumes } = await fixture(t);
  assert.equal((await call("resets", undefined, "member")).status, 403);
  assert.equal(f.resets.calls.length, 0);
  f.resets.mode("synthetic-account", "unknown");
  await use();
  f.advance(10 * 60_000);
  f.restart();
  assert.equal((await call("resets/attempt")).value.canRetryProvider, false);
  assert.equal((await use()).value.outcome, "unknown");
  assert.equal((await use(second)).status, 409);
  assert.equal(consumes().length, 1);
});

test("the synthetic Claude catalog has known usability and definite refusal runs no follow-ups", async (t) => {
  const { f, call, use, consumes } = await fixture(t, "claude");
  assert.equal((await call("resets")).value.credits[0].usableNow, true);
  f.resets.usable("synthetic-account", false);
  assert.equal((await call("resets")).value.credits[0].usableNow, false);
  assert.equal((await use()).status, 409);
  assert.equal(consumes().length, 0);
  f.resets.usable("synthetic-account", true);
  f.resets.mode("synthetic-account", "refused");
  assert.equal((await use()).value.outcome, "not_limited");
  assert.equal(
    f.resets.calls.some((call) => call.action === "clear" || call.action === "collect"),
    false,
  );
  assert.equal(f.resets.remaining("synthetic-account"), 2);
});
