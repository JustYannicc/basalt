import assert from "node:assert/strict";
import { test } from "node:test";
import { accessGrace } from "./access-contract.ts";
import { PoolDirectory } from "./directory.ts";
import { setupTtl } from "./setup-links.ts";
import { fixture, member, owner, pool } from "./test/computers.ts";

const audience = (users = pool.users) => ({ action: "audience" as const, pools: [{ ...pool, users }] });
const own = { pool: "own-pool", owner: member, organization: "own-organization" };
const entry = async (f: ReturnType<typeof fixture>) => (await PoolDirectory.load(f.storage, f.now())).entry(pool.pool)!;

test("a newer stale projection cannot re-add a removed user; a projection after grace can", async () => {
  const f = fixture();
  await f.access(audience());
  const personal = await f.create(member, own);
  await f.access(audience([owner]));
  f.advance(1);
  assert.equal((await f.access(audience())).status, 200);
  assert.deepEqual((await entry(f)).users, [owner]);
  assert.equal((await f.action("switch", member, personal.intent, { id: personal.computer.id, pool: pool.pool })).status, 403);
  f.advance(accessGrace);
  assert.equal((await f.access(audience())).status, 200);
  assert.deepEqual((await entry(f)).users, [owner, member]);
  const fresh = await f.intent(member, own);
  assert.equal((await f.action("switch", member, fresh, { id: personal.computer.id, pool: pool.pool })).status, 200);
});

test("a host-authorized setup restores a re-shared user after refusal while old projections stay blocked", async () => {
  const f = fixture();
  await f.access(audience());
  await f.access(audience([owner]));
  const removalAt = f.now();
  f.advance(accessGrace + 1);
  // A fresh browser-session assertion is sufficient even before another audience arrives.
  const fresh = await f.intent();
  assert.deepEqual((await entry(f)).users, [owner]);
  assert.equal((await f.action("computers", member, fresh)).status, 200);
  assert.ok((await entry(f)).users.includes(member));
  await f.access(audience(), removalAt + 1);
  assert.ok((await entry(f)).users.includes(member));
});

test("pool deletion beats a newer audience and older audiences cannot resurrect it", async () => {
  const f = fixture();
  const computer = await f.create();
  await f.access(audience(), f.now() + 2);
  const deletedAt = f.now();
  assert.equal((await f.access({ action: "pool-deleted", pool: pool.pool }, deletedAt)).status, 200);
  assert.equal(f.server.keys.length, 0);
  assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
  assert.deepEqual((await entry(f)).users, []);
  await f.access(audience(), deletedAt + 3);
  assert.deepEqual((await entry(f)).users, []);
  assert.equal((await f.context(owner)).status, 403);
  f.advance(accessGrace + 1);
  await f.access(audience(), deletedAt - 1);
  assert.deepEqual((await entry(f)).users, []);
  assert.equal((await f.action("links", member, computer.intent)).status, 403);
  const restored = await f.create(owner);
  assert.equal((await f.registry())[restored.computer.id]!.state, "active");
});

test("rolled-back person deletion recovers through a later host call and lazily recreates Home user", async () => {
  const f = fixture();
  await f.access(audience());
  const before = await f.create();
  assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
  assert.equal(f.server.users.length, 0);
  assert.equal((await f.context()).status, 403);
  f.restart();
  f.advance(accessGrace + 1);
  const fresh = await f.intent();
  assert.equal(f.server.users.length, 0);
  const created = await f.action("links", member, fresh, { name: "Restored", toolsKeyId: "restored", toolsToken: "restored" });
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal(f.server.users.length, 1);
  assert.equal(f.server.keys.length, 1);
  assert.equal((await f.registry())[before.computer.id]!.state, "removed");
});

test("later audiences restore deleted pools and people after grace", async () => {
  for (const action of ["pool-deleted", "person-deleted"] as const) {
    const f = fixture();
    await f.access(audience());
    await f.access(action === "pool-deleted" ? { action, pool: pool.pool } : { action, user: member });
    await f.access(audience(), f.now() + 1);
    assert.ok(!(await entry(f)).users.includes(member));
    f.advance(accessGrace + 1);
    assert.equal((await f.access(audience())).status, 200);
    assert.ok((await entry(f)).users.includes(member));
    assert.equal((await f.context()).status, 200);
  }
});

test("failed provisioning stays pending and does not fail an unrelated removal", async (t) => {
  const f = fixture();
  const logged = t.mock.method(console, "error", () => {});
  const computer = await f.create();
  f.server.userFailure = true;
  const change = { action: "audience" as const, pools: [{ ...pool, users: [owner, "new-member"] }] };
  const response = await f.access(change);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { revoked: 1, provisioned: 0 });
  assert.equal(f.server.keys.length, 0);
  assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
  assert.deepEqual((await entry(f)).pending, ["new-member"]);
  assert.equal(logged.mock.calls.length, 1);
  f.restart();
  f.server.userFailure = false;
  const fresh = await f.intent("new-member");
  assert.equal((await f.action("links", "new-member", fresh, { name: "Lazy", toolsKeyId: "lazy", toolsToken: "lazy" })).status, 200);
  const retried = await f.access(change);
  assert.deepEqual(await retried.json(), { revoked: 0, provisioned: 0 });
  assert.deepEqual((await entry(f)).pending, []);
});

test("refusals expire only after every pre-refusal setup intent expires, on access and alarm", async () => {
  for (const alarm of [false, true]) {
    const f = fixture();
    await f.access(audience());
    await f.access({ action: "person-deleted", user: owner });
    const before = f.now() + accessGrace;
    f.advance(accessGrace + setupTtl);
    const prune = () => alarm ? f.expire() : f.access({ action: "audience", pools: [] });
    await prune();
    let directory = await PoolDirectory.load(f.storage, f.now());
    assert.equal(directory.allowed(pool.pool, member, before - 1), false);
    f.advance(1);
    await prune();
    directory = await PoolDirectory.load(f.storage, f.now());
    assert.equal(directory.allowed(pool.pool, member, before - 1), true);
    const state = await f.storage.get<{ refusals: object; people: object }>("pool-directory-v1");
    assert.deepEqual(state?.refusals, {});
    assert.deepEqual(state?.people, {});
    assert.equal(directory.entry(pool.pool)?.refuseBefore, undefined);
  }
});

test("legacy permanent tombstones become time-bound refusals once", async () => {
  const f = fixture();
  await f.storage.put("pool-directory-v1", {
    pools: { [JSON.stringify(pool.pool)]: { ...pool, users: [], at: f.now(), pending: [], deleted: true } },
    refusals: {}, people: { [JSON.stringify(member)]: f.now() },
  });
  assert.equal((await f.context()).status, 403);
  assert.equal((await entry(f)).deleted, undefined);
  f.advance(accessGrace + 1);
  f.restart();
  assert.equal((await f.create()).computer.id.length > 0, true);
});

test("deleting an owner revokes members on every owned pool, without affecting their own computers", async () => {
  const f = fixture();
  const otherOwned = { ...pool, pool: "another-owned" };
  await f.access({ action: "audience", pools: [pool, otherOwned] });
  const shared = await f.create();
  const second = await f.create(member, otherOwned);
  const personal = await f.create(member, own);
  const response = await f.access({ action: "person-deleted", user: owner });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { revoked: 2, provisioned: 0 });
  assert.equal(f.server.keys.length, 1);
  for (const id of [shared.computer.id, second.computer.id]) assert.equal((await f.registry())[id]!.state, "removed");
  assert.equal((await f.registry())[personal.computer.id]!.state, "active");
  assert.equal((await f.context(member)).status, 403);
  assert.equal((await f.context(member, otherOwned)).status, 403);
  assert.equal((await f.context(member, own)).status, 200);
});

test("a personal revoke in flight can finish after access removal", async () => {
  const f = fixture();
  const computer = await f.create();
  assert.equal((await f.action("revoke", member, computer.intent, { id: computer.computer.id })).status, 200);
  assert.equal((await f.registry())[computer.computer.id]!.state, "revoking");
  assert.equal((await f.access(audience([owner]))).status, 200);
  assert.equal((await f.action("revoked", member, computer.intent, { id: computer.computer.id })).status, 200);
  const finished = (await f.registry())[computer.computer.id]!;
  assert.equal(finished.state, "revoked");
  assert.equal(finished.revokedAt, new Date(f.now()).toISOString());
});


test("provisioning continues after one failure and counts only successful creations", async (t) => {
  const f = fixture();
  t.mock.method(console, "error", () => {});
  const provision = f.home.user.bind(f.home);
  t.mock.method(f.home, "user", async (person: string, pool: string, created?: () => void) => {
    if (person === "failed-member") throw new Error("Home user creation failed");
    return provision(person, pool, created);
  });
  const response = await f.access(audience([owner, "failed-member", "working-member"]));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: 0, provisioned: 1 });
  assert.deepEqual((await entry(f)).pending, ["failed-member"]);
  assert.deepEqual((await entry(f)).provisioned, ["working-member"]);
});
