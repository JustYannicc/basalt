import assert from "node:assert/strict";
import { test } from "node:test";
import { accessGrace, accessTtl } from "./access-contract.ts";
import { fixture, member, owner, pool, previousKey, signingKey } from "./test/computers.ts";

import { Computers } from "./computers.ts";
import { signEnvelope, signPoolToken } from "./token.ts";

const audience = (users = pool.users) => ({ action: "audience" as const, pools: [{ ...pool, users }] });

test("access accepts the previous signing key and rejects forgery, expiry, excess TTL and other envelope kinds", async () => {
  const f = fixture();
  assert.equal((await f.access(audience(), f.now(), previousKey)).status, 200);
  for (const response of [
    await f.access(audience(), f.now(), "ef".repeat(32)),
    await f.access(audience(), f.now(), previousKey, f.now()),
    await f.access(audience(), f.now(), previousKey, f.now() - 1),
    await f.access(audience(), f.now(), previousKey, f.now() + accessTtl + 1),
    await f.access(audience(), f.now(), previousKey, f.now() + accessTtl, "sbp1"),
    await f.access(audience(), f.now(), previousKey, f.now() + accessTtl, "sbs1"),
  ]) assert.equal(response.status, 401, await response.clone().text());
});

test("access rejects malformed payloads and never takes a pool token as authority", async () => {
  const f = fixture();
  const computers = new Computers({ storage: f.storage, home: f.home, signingKey, now: f.now });
  for (const change of [
    { action: "audience", pools: [{ ...pool, users: [42] }] },
    { action: "audience", pools: [pool, pool] },
    { action: "pool-deleted", pool: "" }, { action: "person-deleted", user: "" }, { action: "other" },
  ]) {
    // Deliberately send malformed signed input through the public assertion reader.
    const envelope = await signEnvelope(signingKey, "sba1", { ...change, at: f.now(), expiresAt: f.now() + accessTtl });
    const response = await computers.access(new Request("https://pool.example/pool/v1/access", { method: "POST", body: JSON.stringify({ envelope }) }));
    assert.equal(response.status, 401);
  }
  const token = await signPoolToken(signingKey, pool);
  for (const body of ["{}", "{", JSON.stringify({ envelope: token })]) {
    assert.equal((await computers.access(new Request("https://pool.example/pool/v1/access", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body,
    }))).status, 401);
  }
  assert.equal((await computers.access(new Request("https://pool.example/pool/v1/access"))).status, 401);
  assert.equal(f.server.calls.length, 0);
});

test("audience provisioning creates a Home user once, including an audience learned through context", async () => {
  const f = fixture();
  await f.intent();
  const first = await f.access(audience());
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(await first.json(), { revoked: 0, provisioned: 1 });
  assert.equal((await f.access(audience())).status, 200);
  assert.equal(f.server.users.length, 1);
  assert.equal(f.server.users[0]!.username, await f.userName(member));
  assert.equal(f.server.calls.filter((call) => call.path === "/users" && call.method === "POST").length, 1);
});

test("stale audience entries are ignored independently while newer entries still apply", async () => {
  const f = fixture();
  assert.equal((await f.access(audience(), f.now() + 2)).status, 200);
  const second = { ...pool, pool: "pool-b", name: "Second pool" };
  const response = await f.access({ action: "audience", pools: [{ ...pool, users: [owner] }, second] }, f.now() + 1);
  assert.equal(response.status, 200);
  const context = await f.action("computers", member, await f.intent());
  const value = await context.json() as { pools: { id: string }[] };
  assert.deepEqual(value.pools.map((pool) => pool.id).sort(), [pool.pool, second.pool]);
  assert.equal((await f.access({ action: "pool-deleted", pool: pool.pool }, f.now())).status, 200);
  assert.equal((await f.context()).status, 403);
});

test("an existing member Home user is reused and does not count as provisioned again", async () => {
  const f = fixture();
  await f.create();
  const response = await f.access(audience());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: 0, provisioned: 0 });
  assert.equal(f.server.users.length, 1);
});

test("removal waits for key deletion, persists refusal first and serializes mint and switch behind it", async () => {
  const f = fixture();
  assert.equal((await f.access(audience())).status, 200);
  const computer = await f.create(member, pool, false);
  const own = { pool: "own-pool", owner: member, organization: "own-organization" };
  const other = await f.create(member, own);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.server.revokeGate = new Promise<void>((resolve) => { release = resolve; });
  f.server.onRevoke = started;
  let complete = false;
  const removal = f.access(audience([owner]), f.now() + 1).then((response) => { complete = true; return response; });
  await entered;
  assert.equal(complete, false);
  assert.match(JSON.stringify(await f.storage.get("pool-directory-v1")), /refusals/);
  assert.equal((await f.registry())[computer.computer.id]!.link, undefined);
  const mint = f.action("links", member, computer.intent, { name: "Other", toolsKeyId: "tools-other", toolsToken: "fake-tools-other" });
  const change = f.action("switch", member, other.intent, { id: other.computer.id, pool: pool.pool });
  release();
  assert.equal((await removal).status, 200);
  assert.equal((await mint).status, 403);
  assert.equal((await change).status, 403);
  const removed = (await f.registry())[computer.computer.id]!;
  assert.equal(removed.state, "removed");
  assert.equal(removed.removedAt, new Date(f.now()).toISOString());
  assert.equal(removed.toolsKeyId, `tools-${member}`);
  assert.equal(f.server.keys.length, 1);
  assert.equal((await f.action("claim", member, undefined, { token: computer.token })).status, 410);
});

test("failed deletion returns 503; persisted removal survives restart and retry finishes it", async () => {
  const f = fixture();
  const computer = await f.create();
  f.server.revokeFailure = true;
  assert.equal((await f.access(audience([owner]))).status, 503);
  assert.equal(f.server.keys.length, 1);
  assert.equal((await f.registry())[computer.computer.id]!.removalPending, true);
  f.restart();
  assert.equal((await f.context()).status, 403);
  f.server.revokeFailure = false;
  // Simulate a backend deletion succeeding just before a failed response.
  f.server.keys = [];
  const response = await f.access(audience([owner]));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
  assert.equal((await f.registry())[computer.computer.id]!.removalPending, undefined);
});

test("refusal blocks context and every intent action through grace, then requires a newly issued intent", async () => {
  const f = fixture();
  const computer = await f.create(member, pool, false);
  assert.equal((await f.access(audience([owner]))).status, 200);
  assert.equal((await f.context()).status, 403);
  const own = { pool: "own-pool", owner: member, organization: "own-organization" };
  const active = await f.create(member, own);
  for (const action of ["links", "refresh", "computers", "validate", "switch"]) {
    const response = await f.action(action, member, computer.intent, { id: computer.computer.id, pool: own.pool });
    assert.equal(response.status, 403, `${action}: ${await response.clone().text()}`);
  }
  assert.equal((await f.action("refresh", member, active.intent, { id: computer.computer.id })).status, 403);
  f.advance(accessGrace - 1);
  assert.equal((await f.context()).status, 403);
  f.advance(1);
  assert.equal((await f.action("links", member, computer.intent, { name: "New", toolsKeyId: "new", toolsToken: "fake-new" })).status, 403);
  const fresh = await f.intent();
  assert.equal((await f.action("links", member, fresh, { name: "New", toolsKeyId: "new", toolsToken: "fake-new" })).status, 200);
  assert.equal((await f.action("switch", member, fresh, { id: active.computer.id, pool: pool.pool })).status, 200);
});

test("a provisioning failure can be retried without losing pending users", async () => {
  const f = fixture();
  f.server.userFailure = true;
  assert.equal((await f.access(audience())).status, 200);
  f.restart();
  f.server.userFailure = false;
  assert.equal((await f.access(audience())).status, 200);
  assert.equal(f.server.users.length, 1);
});

test("pool deletion revokes keys, refuses stale intents and recovers after rollback", async () => {
  const f = fixture();
  const computer = await f.create();
  const ownerComputer = await f.create(owner);
  const own = { pool: "own-pool", owner: member, organization: "own-organization" };
  const other = await f.create(member, own);
  assert.equal((await f.access({ action: "pool-deleted", pool: pool.pool })).status, 200);
  assert.equal(f.server.keys.length, 1);
  assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
  assert.equal((await f.registry())[ownerComputer.computer.id]!.state, "removed");
  f.advance(accessGrace + 1);
  assert.equal((await f.context(owner)).status, 200);
  assert.equal((await f.action("links", member, computer.intent)).status, 403);
  assert.equal((await f.action("switch", member, other.intent, { id: other.computer.id, pool: pool.pool })).status, 403);
  assert.equal((await f.access(audience(), f.now())).status, 200);
  assert.equal((await f.context()).status, 200);
});

test("person deletion removes computers in all pools, unregistered Home keys, then the Home user", async () => {
  const f = fixture();
  await f.access(audience());
  const first = await f.create();
  const secondPool = { pool: "pool-b", owner, organization: "organization-b" };
  const second = await f.create(member, secondPool, false);
  await f.create(owner);
  const userId = await f.home.user(member);
  f.server.keys.push({ id: 900, api_key_id: 900, user_id: userId, display_name: "unregistered" });
  const response = await f.access({ action: "person-deleted", user: member });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { revoked: 3, provisioned: 0 });
  assert.equal(f.server.keys.length, 1);
  assert.equal(f.server.users.length, 1);
  assert.ok(!f.server.users.some((user) => user.id === userId));
  for (const id of [first.computer.id, second.computer.id]) assert.equal((await f.registry())[id]!.state, "removed");
  assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
  assert.equal((await f.context()).status, 403);
});

test("person deletion retries a failed user delete without recreating the user or losing other keys", async () => {
  const f = fixture();
  await f.create();
  f.server.deleteUserFailure = true;
  assert.equal((await f.access({ action: "person-deleted", user: member })).status, 503);
  assert.equal(f.server.keys.length, 0);
  f.restart();
  f.server.deleteUserFailure = false;
  assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
  assert.equal(f.server.users.length, 0);
});
