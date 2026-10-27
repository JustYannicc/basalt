import assert from "node:assert/strict";
import { test } from "node:test";
import { afterFreshDns } from "./fresh-dns.ts";

const unresolved = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

test("a new hostname is retried while it does not resolve, then the first response is returned", async () => {
  let attempts = 0;
  let clock = 0;
  const result = await afterFreshDns(async () => {
    attempts += 1;
    if (attempts < 3) throw unresolved(attempts === 1 ? "ENOTFOUND" : "EAI_AGAIN");
    return "response";
  }, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(result, "response");
  assert.equal(attempts, 3);
});

test("other failures and resolution failures past the deadline are not retried", async () => {
  let attempts = 0;
  await assert.rejects(afterFreshDns(async () => { attempts += 1; throw unresolved("ECONNREFUSED"); }, { sleep: async () => {} }), /fetch failed/);
  assert.equal(attempts, 1);
  let clock = 0;
  attempts = 0;
  await assert.rejects(afterFreshDns(async () => { attempts += 1; throw unresolved("ENOTFOUND"); },
    { timeoutMs: 30_000, intervalMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; } }), /fetch failed/);
  assert.equal(attempts, 4);
});
