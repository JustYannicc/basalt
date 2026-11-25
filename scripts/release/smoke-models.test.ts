import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { HttpStatusFailure, TransportFailure, UserCapReached } from "../pool-acceptance/types.ts";
import {
  firstServing,
  quotaRefusal,
  servedBeforeApply,
  smokeAfterApply,
  smokeModels,
} from "./smoke-models.ts";

const credential = async () => ({ "x-basalt-native-assertion": "fixture" });

/** A model call the pool refuses with this status and JSON body, through the real client. */
async function refused(status: number, body: unknown) {
  const client = new PoolAcceptanceClient({
    origin: "https://pool.example.invalid",
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  });
  return client.sendTurn(credential, "model-a", { id: "turn", expectedRecords: 1 }).then(
    () => assert.fail("the turn was refused"),
    (error: unknown) => error,
  );
}

// The pool's node relays a Home refusal under a generic type and code, with Home's code first in
// the message: this is the body a pool with no funded account sent on 25 Nov.
const funding = {
  error: {
    message: "usage_credit_policy_denied: No account has funding allowed by this pool.",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  },
};

test("the pool's quota refusals are read from the body, and nothing else is quota", async () => {
  assert.equal(quotaRefusal(await refused(429, funding)), "usage_credit_policy_denied");
  const relayedCooldown = {
    error: { ...funding.error, message: "model_cooldown: all credentials are cooling down" },
  };
  assert.equal(quotaRefusal(await refused(429, relayedCooldown)), "model_cooldown");
  // The node's own selector names the cool-down as the code itself.
  const ownCooldown = { error: { code: "model_cooldown", message: "All credentials for model x" } };
  assert.equal(quotaRefusal(await refused(429, ownCooldown)), "model_cooldown");
  for (const [why, status, body] of [
    // A provider's own limit passed through: the same type and code, but no Home code first.
    ["a provider's limit", 429, { error: { ...funding.error, message: "Rate limit reached" } }],
    [
      "a credential's concurrency",
      429,
      { error: { ...funding.error, message: "credential_concurrency_exceeded: busy" } },
    ],
    ["Anthropic's own shape", 429, { type: "error", error: { type: "rate_limit_error" } }],
    ["the funding text under another status", 503, funding],
    [
      "the funding code without the relay's type",
      429,
      { error: { message: funding.error.message } },
    ],
  ] as const)
    assert.equal(quotaRefusal(await refused(status, body)), undefined, why);
  // The pool's per-user cap stays its own refusal, never quota.
  const cap = await refused(429, {
    error: { message: "cap", type: "rate_limit_error", code: "user_period_limit_exceeded" },
  });
  assert.ok(cap instanceof UserCapReached);
  assert.equal(quotaRefusal(cap), undefined);
});

const quota = () =>
  new HttpStatusFailure(429, "refused", {
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
    prefix: "usage_credit_policy_denied",
  });

test("a quota refusal moves to the next model, and the first served turn passes", async () => {
  const sent: string[] = [];
  const result = await firstServing(["claude-opus-5-5", "gpt-6.1-sol"], async (model) => {
    sent.push(model);
    if (model === "claude-opus-5-5") throw quota();
  });
  assert.deepEqual(sent, ["claude-opus-5-5", "gpt-6.1-sol"]);
  assert.deepEqual(result, {
    model: "gpt-6.1-sol",
    tried: ["claude-opus-5-5: usage_credit_policy_denied, HTTP 429"],
  });
});

test("any other failure ends the tries, an unknown 429 included", async () => {
  for (const failure of [
    new HttpStatusFailure(503, "refused"),
    new HttpStatusFailure(429, "refused", {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    }),
    new TransportFailure("connect failed to a host name"),
  ]) {
    const sent: string[] = [];
    const result = await firstServing(["claude-opus-5-5", "gpt-6.1-sol"], async (model) => {
      sent.push(model);
      throw failure;
    });
    assert.deepEqual(sent, ["claude-opus-5-5"], "no second model");
    assert.equal(result.model, undefined);
    assert.equal(result.tried.length, 1);
    // Codes, statuses and class names only: never an error's own text.
    assert.doesNotMatch(result.tried[0]!, /host name/u);
  }
});

test("before the apply, a pool that serves no model for quota stops the deploy", async () => {
  const stopped = await servedBeforeApply(["claude-opus-5-5", "gpt-6.1-sol"], async () => {
    throw quota();
  });
  assert.deepEqual(stopped, {
    stop:
      "No acceptance model served a turn before the apply (claude-opus-5-5: usage_credit_policy_denied, HTTP 429; " +
      "gpt-6.1-sol: usage_credit_policy_denied, HTTP 429); nothing applied",
  });
  const served = await servedBeforeApply(["claude-opus-5-5", "gpt-6.1-sol"], async (model) => {
    if (model === "claude-opus-5-5") throw quota();
  });
  assert.deepEqual(served, {
    model: "gpt-6.1-sol",
    line: "Before the apply, gpt-6.1-sol served a turn; first claude-opus-5-5: usage_credit_policy_denied, HTTP 429.",
  });
});

test("the configured model goes first, then the repository's other acceptance models", () => {
  assert.deepEqual(smokeModels("claude-opus-5-5"), ["claude-opus-5-5", "gpt-6.1-sol"]);
  assert.deepEqual(smokeModels("gpt-6.1-sol"), ["gpt-6.1-sol", "claude-opus-5-5"]);
});

test("after the apply, only the model that served is tried, and any refusal fails the smoke", async () => {
  const sent: string[] = [];
  // The same quota refusal that moved on before the apply is now the release's to answer for.
  const refusedNow = await smokeAfterApply("claude-opus-5-5", async (model) => {
    sent.push(model);
    throw quota();
  });
  assert.deepEqual(sent, ["claude-opus-5-5"]);
  assert.deepEqual(refusedNow, {
    passed: false,
    why: "claude-opus-5-5: usage_credit_policy_denied, HTTP 429",
  });
  assert.deepEqual(await smokeAfterApply("gpt-6.1-sol", async () => {}), { passed: true });
});
