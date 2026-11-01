import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName } from "./backend-users.ts";
import { fixture, member, owner, pool } from "./test/computers.ts";
import { markSetupCompleted } from "./usage-observation.ts";
import type { Computer, PoolChoice } from "../../apps/pool/ui/computer-types.ts";

test("non-owner context is pool-scoped while browser setup lists every personal computer and pool", async () => {
  const f = fixture();
  const own = { pool: "own-pool", owner: member, organization: "own-organization" };
  const shared = await f.create();
  const personal = await f.create(member, own);
  await f.create(owner);
  await f.access({ action: "audience", pools: [pool, { ...own, name: "Personal pool", users: [] },
    { ...pool, pool: "unavailable", owner: "other-owner", users: [] }] });
  const context = await f.context();
  const value = await context.json() as { computers: Computer[]; pools: PoolChoice[]; shareHref?: string; intent: string };
  assert.deepEqual(value.computers.map((computer) => computer.id).sort(), [shared.computer.id]);
  assert.deepEqual(value.pools, [{ id: pool.pool, name: pool.name, mine: false }]);
  assert.equal(value.shareHref, undefined);
  assert.ok(value.computers.every((computer) => computer.removedAt === null));
  assert.ok(!JSON.stringify(value).includes("fake-tools-"));
  assert.ok(!JSON.stringify(value).includes("keyId"));
  const listed = await f.action("computers", member, value.intent);
  const list = await listed.json() as { computers: Computer[]; pools: PoolChoice[] };
  assert.deepEqual(list.computers.map((computer) => computer.id).sort(), [shared.computer.id, personal.computer.id].sort());
  assert.deepEqual(list.pools, [{ id: pool.pool, name: pool.name, mine: false }, { id: own.pool, name: "Personal pool", mine: true }]);
  const validation = await f.action("validate", member, value.intent);
  assert.deepEqual(await validation.json(), { pool: pool.pool, owner, organization: pool.organization, name: pool.name });
  const ownerContext = await f.context(owner);
  const ownerView = await ownerContext.json() as { intent: string; shareHref: string };
  assert.equal(ownerView.shareHref, `https://setup.example/org/${pool.organization}/apps/${pool.pool}?view=settings`);
});

test("an unknown pool learned from context has an empty display name", async () => {
  const f = fixture();
  const intent = await f.intent();
  const listed = await f.action("computers", member, intent);
  assert.deepEqual(await listed.json(), { computers: [], pools: [{ id: pool.pool, name: "", mine: false }] });
  const validated = await f.action("validate", member, intent);
  assert.deepEqual(await validated.json(), { pool: pool.pool, owner, organization: pool.organization, name: "" });
});

test("switch patches the same key, sets its pool and binding time, and a repeat is a no-op", async () => {
  const f = fixture();
  const computer = await f.create();
  const target = { ...pool, pool: "pool-b", name: "Second pool" };
  await f.access({ action: "audience", pools: [pool, target] });
  const before = structuredClone(f.server.keys[0]!);
  const registry = await f.registry();
  registry[computer.computer.id]!.firstModelRequestAt = new Date(f.now()).toISOString();
  registry[computer.computer.id]!.firstToolCallAt = new Date(f.now()).toISOString();
  await f.storage.put("computer-registry-v1", registry);
  f.advance(1_000);
  const response = await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: target.pool });
  assert.equal(response.status, 200, await response.clone().text());
  const view = await response.json() as Computer;
  assert.equal(view.poolId, target.pool);
  assert.equal(view.firstModelRequestAt, null);
  assert.equal(view.firstToolCallAt, registry[computer.computer.id]!.firstToolCallAt);
  assert.equal((await f.registry())[computer.computer.id]!.boundAt, new Date(f.now()).toISOString());
  assert.equal(f.server.keys.length, 1);
  assert.equal(f.server.keys[0]!.api_key_id, before.api_key_id);
  assert.equal(f.server.keys[0]!.api_key, before.api_key);
  const patch = f.server.calls.filter((call) => call.path === "/access/api-keys" && call.method === "PATCH");
  assert.equal(patch.length, 1);
  const targetUserName = await backendUserName(member, target.pool);
  const targetUser = f.server.users.find((user) => user.username === targetUserName)!;
  assert.notEqual(targetUser.id, before.user_id);
  assert.equal(f.server.keys[0]!.user_id, targetUser.id);
  assert.equal((await f.registry())[computer.computer.id]!.userId, targetUser.id);
  assert.deepEqual(patch[0]!.body, { api_key_id: before.api_key_id, user_id: targetUser.id, channels: [f.server.groups.find((group) => String(group.channel_name).endsWith(target.pool))!.id] });
  const boundAt = (await f.registry())[computer.computer.id]!.boundAt;
  f.advance(1_000);
  assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: target.pool })).status, 200);
  assert.equal(f.server.calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal((await f.registry())[computer.computer.id]!.boundAt, boundAt);
});

test("switch refuses unavailable pools, other people's computers and unclaimed computers", async () => {
  const f = fixture();
  const computer = await f.create();
  const other = await f.create(owner);
  const issuing = await f.create(member, pool, false);
  for (const input of [{ id: computer.computer.id, pool: "unknown" }, { id: computer.computer.id, pool: "" }])
    assert.equal((await f.action("switch", member, computer.intent, input)).status, 403);
  assert.equal((await f.action("switch", member, computer.intent, { id: other.computer.id, pool: pool.pool })).status, 404);
  assert.equal((await f.action("switch", member, computer.intent, { id: issuing.computer.id, pool: pool.pool })).status, 409);
  assert.equal(f.server.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("removal finds a key from an interrupted mint before it was acknowledged", async () => {
  const f = fixture();
  const intent = await f.intent();
  f.server.mintReplyFailure = true;
  const minted = await f.action("links", member, intent, { name: "Laptop", toolsKeyId: "tools-key", toolsToken: "fake-tools-key" });
  assert.equal(minted.status, 503);
  assert.equal(f.server.keys.length, 1);
  const response = await f.access({ action: "audience", pools: [{ ...pool, users: [owner] }] });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.server.keys.length, 0);
  assert.equal(Object.values(await f.registry())[0]!.state, "removed");
});

test("removal also revokes a key whose switch took effect but its response failed", async () => {
  const f = fixture();
  const computer = await f.create();
  const target = { ...pool, pool: "pool-b" };
  await f.access({ action: "audience", pools: [pool, target] });
  f.server.patchReplyFailure = true;
  assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: target.pool })).status, 503);
  assert.deepEqual((await f.registry())[computer.computer.id]!.switching, [target.pool]);
  f.restart();
  const response = await f.access({ action: "audience", pools: [{ ...target, users: [owner] }] }, f.now() + 1);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.server.keys.length, 0);
  assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
});

test("a forged non-owner caller exposes no other computers or pools and cannot learn a picker entry", async () => {
  const f = fixture();
  const own = { pool: "victim-pool", owner: member, organization: "victim-organization" };
  const personal = await f.create(member, own);
  await f.access({ action: "audience", pools: [{ ...pool, users: [owner] }] });
  const response = await f.context(member);
  assert.equal(response.status, 200);
  const value = await response.json() as { computers: Computer[]; pools: PoolChoice[]; shareHref?: string };
  assert.deepEqual(value.computers, []);
  assert.deepEqual(value.pools, [{ id: pool.pool, name: pool.name, mine: false }]);
  assert.equal(value.shareHref, undefined);
  const listed = await f.action("computers", member, personal.intent);
  const browser = await listed.json() as { computers: Computer[]; pools: PoolChoice[] };
  assert.deepEqual(browser.computers.map((computer) => computer.id), [personal.computer.id]);
  assert.deepEqual(browser.pools.map((pool) => pool.id), [own.pool]);
  const directory = await f.storage.get<{ pools: Record<string, { users: string[] }> }>("pool-directory-v1");
  assert.deepEqual(directory?.pools[JSON.stringify(pool.pool)]?.users, [owner]);
});

test("an unknown forged caller never creates a directory entry", async () => {
  const f = fixture();
  assert.equal((await f.context()).status, 200);
  assert.equal(await f.storage.get("pool-directory-v1"), undefined);
});

test("every uncertain switch destination survives later failure and legacy migration until revocation", async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    const computer = await f.create();
    const target = { ...pool, pool: "pool-b" };
    const next = { ...pool, pool: "pool-c" };
    await f.access({ action: "audience", pools: [pool, target, next] });
    f.server.patchReplyFailure = true;
    assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: target.pool })).status, 503);
    const onTarget = structuredClone(f.server.keys[0]!.channels);
    if (legacy) {
      const registry = await f.registry();
      registry[computer.computer.id]!.switchingTo = target.pool;
      delete registry[computer.computer.id]!.switching;
      await f.storage.put("computer-registry-v1", registry);
    }
    f.restart();
    f.server.patchFailure = true;
    assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: next.pool })).status, 503);
    assert.deepEqual(f.server.keys[0]!.channels, onTarget);
    assert.deepEqual((await f.registry())[computer.computer.id]!.switching, [target.pool, next.pool]);
    assert.equal((await f.registry())[computer.computer.id]!.switchingTo, undefined);
    const context = await f.context(member, target);
    const view = await context.json() as { computers: Computer[] };
    assert.deepEqual(view.computers.map((row) => row.id), [computer.computer.id]);
    f.server.revokeFailure = true;
    assert.equal((await f.access({ action: "audience", pools: [{ ...target, users: [owner] }] })).status, 503);
    f.advance(60_001);
    assert.equal((await f.context(member, target)).status, 503);
    f.server.revokeFailure = false;
    const response = await f.access({ action: "audience", pools: [{ ...target, users: [owner] }] });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(f.server.keys.length, 0);
    assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
    assert.equal((await f.registry())[computer.computer.id]!.switching, undefined);
  }
});

test("a successful switch clears all uncertain destinations", async () => {
  const f = fixture();
  const computer = await f.create();
  const target = { ...pool, pool: "pool-b" };
  await f.access({ action: "audience", pools: [pool, target] });
  f.server.patchReplyFailure = true;
  assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: target.pool })).status, 503);
  f.server.patchReplyFailure = false;
  assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: pool.pool })).status, 200);
  assert.equal((await f.registry())[computer.computer.id]!.switching, undefined);
  assert.equal((await f.access({ action: "audience", pools: [{ ...target, users: [owner] }] })).status, 200);
  assert.equal(f.server.keys.length, 1);
});

test("pool creation is credited to the pool's owner, whoever's mint or switch creates its group", async () => {
  const f = fixture();
  const own = { pool: "own-pool", owner: member, organization: "own-organization" };
  await f.access({ action: "audience", pools: [pool, { ...own, name: "Personal pool", users: [] }] });
  // A member's first mint on a shared pool creates its group: the owner is credited.
  const shared = await f.create();
  assert.deepEqual(f.events.filter(([event]) => event === "pool_created"), [["pool_created", owner]]);
  // Switching onto the member's own pool creates that group: the member owns it.
  const switched = await f.action("switch", member, shared.intent, { id: shared.computer.id, pool: own.pool });
  assert.equal(switched.status, 200, await switched.clone().text());
  assert.deepEqual(f.events.filter(([event]) => event === "pool_created"), [["pool_created", owner], ["pool_created", member]]);
});

test("a link mints on any pool the person can use and refuses the rest", async () => {
  const f = fixture();
  const target = { ...pool, pool: "pool-b", name: "Second pool" };
  await f.access({ action: "audience", pools: [pool, target] });
  const intent = await f.intent();
  const response = await f.action("links", member, intent, { name: "Laptop", pool: target.pool });
  assert.equal(response.status, 200, await response.clone().text());
  const { computer } = await response.json() as { computer: Computer };
  assert.equal(computer.poolId, target.pool);
  assert.equal((await f.registry())[computer.id]!.pool, target.pool);
  const refused = await f.action("links", member, intent, { name: "Laptop", pool: "unavailable" });
  assert.equal(refused.status, 403);
  assert.equal(Object.keys(await f.registry()).length, 1);
});

test("a models-only computer carries no tools pair and revokes without one", async () => {
  const f = fixture();
  const intent = await f.intent();
  const created = await f.action("links", member, intent, { name: "Laptop" });
  assert.equal(created.status, 200, await created.clone().text());
  const value = await created.json() as { computer: Computer; token: string };
  assert.equal(value.computer.tools, false);
  const claimed = await f.action("claim", member, undefined, { token: value.token, format: "json" });
  const { credentials } = await claimed.json() as { credentials: Record<string, unknown> };
  assert.deepEqual(Object.keys(credentials).sort(), ["modelKey", "modelUrl"]);
  const revoked = await f.action("revoke", member, intent, { id: value.computer.id });
  assert.deepEqual(await revoked.json(), { toolsKeyId: null });
});

test("a models-only computer completes setup on its first model request", () => {
  const now = () => Date.parse("2026-01-01T00:00:00Z");
  const base = { id: "c", user: member, pool: pool.pool, createdAt: "", boundAt: "", state: "active" as const,
    firstModelRequestAt: "2026-01-01T00:00:00Z", firstToolCallAt: null };
  assert.equal(markSetupCompleted({ ...base }, now), true);
  assert.equal(markSetupCompleted({ ...base, toolsKeyId: "tools" }, now), false);
});

test("a person renames only their own computer, to a valid name", async () => {
  const f = fixture();
  const created = await f.create();
  const rename = (user: string, intent: string, name: unknown) => f.action("rename", user, intent, { id: created.computer.id, name });
  const renamed = await rename(member, created.intent, " Work laptop ");
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await renamed.json() as Computer).name, "Work laptop");
  assert.equal((await rename(member, created.intent, "x".repeat(61))).status, 400);
  assert.equal((await rename(owner, await f.intent(owner), "Mine now")).status, 404);
  assert.equal((await f.registry())[created.computer.id]!.name, "Work laptop");
});

test("an unclaimed computer is marked lapsed once its link expires, and never after a claim", async () => {
  const f = fixture();
  const waiting = await f.create(member, pool, false);
  const claimed = await f.create(member, pool, true);
  const list = async () => (await (await f.action("computers", member, await f.intent())).json() as { computers: Computer[] }).computers;
  const lapsed = (computers: Computer[], id: string) => computers.find((computer) => computer.id === id)?.lapsed;
  assert.equal(lapsed(await list(), waiting.computer.id), undefined);
  f.advance(5 * 60_000 + 1);
  const later = await list();
  assert.equal(lapsed(later, waiting.computer.id), true);
  assert.equal(lapsed(later, claimed.computer.id), undefined);
});
