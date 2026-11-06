import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeTransportFailure } from "./json.ts";
import { PoolAccountRemovals } from "./account-removals.ts";
import { handleRemovalIntent, removalIntentPath, removalIntentPrefix } from "./removal-intent.ts";
import { signEnvelope } from "./token.ts";
const key = "ab".repeat(32);
const now = Date.UTC(2026, 10, 6);
const request = async (value: object = {}, signingKey = key, prefix = removalIntentPrefix) =>
  new Request("https://pool.test/pool/v1/account-removal-intents", {
    method: "POST",
    body: JSON.stringify({
      envelope: await signEnvelope(signingKey, prefix, {
        audience: removalIntentPath,
        pool: "pool",
        actor: "person",
        reference: "account",
        operation: "operation",
        at: now,
        expiresAt: now + 30_000,
        ...value,
      }),
    }),
  });
function fixture() {
  const stored = new Map<string, unknown>();
  const history = new PoolAccountRemovals({
    async get<T>(name: string) {
      return structuredClone(stored.get(name)) as T | undefined;
    },
    async put(name, value) {
      writes++;
      stored.set(name, structuredClone(value));
    },
  });
  let writes = 0;
  let clock = now;
  let selected: string[] = [];
  let failed = false;
  return {
    history,
    writes: () => writes,
    advance() {
      clock++;
    },
    selected(value: string[]) {
      selected = value;
    },
    fail() {
      failed = true;
    },
    run: async (req: Request) =>
      handleRemovalIntent(req, {
        signingKey: key,
        now: () => clock,
        refresh: async () => {
          if (failed) throw new HomeTransportFailure("transport");
        },
        selected: async () => selected,
        record: (pool, refs, actor, operation, issuedAt) =>
          history.recordMany(pool, refs, actor, new Date(clock), operation, issuedAt),
      }),
  };
}
test("a replayed native removal is refused without rewriting the authenticated receipt", async () => {
  const f = fixture();
  assert.equal((await f.run(await request())).status, 204);
  const first = await f.history.read("pool");
  assert.deepEqual(first, {
    since: null,
    items: [{ account: "account", actor: "person", at: new Date(now).toISOString() }],
  });
  f.advance();
  assert.equal((await f.run(await request())).status, 409);
  assert.equal(f.writes(), 1);
  assert.deepEqual(await f.history.read("pool"), first);
});
test("a pool token, absent person, acquisition owner and expired assertion cannot mint removal intent", async () => {
  const f = fixture();
  for (const input of [
    { actor: "" },
    { actor: "organization:org" },
    { expiresAt: now },
    { at: now + 1 },
  ])
    assert.equal((await f.run(await request(input))).status, 401);
  assert.equal((await f.run(await request({}, "cd".repeat(32)))).status, 401);
  assert.equal(
    (
      await f.run(
        new Request("https://pool.test/pool/v1/account-removal-intents", {
          method: "POST",
          headers: { authorization: "Bearer pool-token" },
          body: "{}",
        }),
      )
    ).status,
    401,
  );
  assert.deepEqual((await f.history.read("pool")).items, []);
});
test("a retained selection or failed membership acknowledgement cannot claim a removal", async () => {
  const f = fixture();
  f.selected(["account"]);
  assert.equal((await f.run(await request())).status, 409);
  assert.deepEqual((await f.history.read("pool")).items, []);
  f.selected([]);
  f.fail();
  assert.equal((await f.run(await request())).status, 503);
  assert.deepEqual((await f.history.read("pool")).items, []);
});

for (const [name, value, signingKey, prefix] of [
  ["bad signature", {}, "cd".repeat(32), removalIntentPrefix],
  ["expired assertion", { expiresAt: now }, key, removalIntentPrefix],
  [
    "wrong endpoint audience",
    { audience: "/pool/v1/account-acquisitions" },
    key,
    removalIntentPrefix,
  ],
  ["wrong signing purpose", {}, key, "sba1"],
] as const)
  test(`${name} is refused without writing a receipt`, async () => {
    const f = fixture();
    assert.equal((await f.run(await request(value, signingKey, prefix))).status, 401);
    assert.equal(f.writes(), 0);
    assert.deepEqual((await f.history.read("pool")).items, []);
  });
