import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { backendUserName, digest } from "./backend-users.ts";
import { Computers } from "./computers.ts";
import type { Registry } from "./computer-registry.ts";
import { ComputerHome } from "./computer-home.ts";
import { HomeClient, poolGroupPrefix } from "./control.ts";
import { readCap, setCap } from "./caps.ts";
import { type Json } from "./json.ts";
import { Memory } from "./test/computers.ts";
import { setupTtl, signIntent } from "./setup-links.ts";
import { signEnvelope } from "./token.ts";
import { accessPrefix } from "./access-contract.ts";

async function fixture(count = 2) {
  const legacy = `${brand.setup.id}-${await digest("member")}`;
  const users: Json[] = [{ id: 1, username: legacy, credits_unlimited: true }];
  const keys: Json[] = Array.from({ length: count }, (_, i) => ({ api_key_id: i + 1, user_id: 1, channels: [i % 2 + 11] }));
  const calls: { path: string; method: string; body?: Json }[] = [];
  let nextId = 20, failPatch = 0, clock = Date.parse("2026-10-24T00:00:00Z");
  let patchGate: (() => Promise<void>) | undefined;
  const client = new HomeClient(async (raw, init) => {
    const path = raw.replace("/v8/management", ""), method = init?.method ?? "GET";
    const body: Json | undefined = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/users") {
      if (method === "POST") users.push({ id: nextId++, limit_7d_credits: null, ...body });
      return Response.json({ users });
    }
    if (path === "/channel-groups") return Response.json({ channel_groups: [
      { id: 11, channel_name: `${poolGroupPrefix}pool-a` }, { id: 12, channel_name: `${poolGroupPrefix}pool-b` },
      { id: 13, channel_name: "unrelated" },
    ] });
    if (path === "/access/api-keys") {
      if (method === "PATCH") {
        await patchGate?.();
        if (body?.api_key_id === failPatch) return Response.json({}, { status: 500 });
        Object.assign(keys.find((key) => key.api_key_id === body?.api_key_id)!, body);
      }
      return Response.json({ items: keys });
    }
    if (path.startsWith("/access/api-keys?id=")) {
      keys.splice(keys.findIndex((key) => key.api_key_id === Number(path.split("=")[1])), 1);
      return Response.json({});
    }
    const user = users.find((user) => path === `/users/${user.id}`);
    assert.ok(user, path);
    if (method === "DELETE") users.splice(users.indexOf(user), 1);
    else Object.assign(user, body);
    return Response.json({});
  });
  const storage = new Memory(), home = new ComputerHome(client), signingKey = "ab".repeat(32);
  const usage = { summary: async () => { throw Error("Unexpected summary"); },
    setCap: async (pool: string, _owner: string, member: string, weekly: number | null) => setCap(client, member, pool, weekly) };
  const make = () => new Computers({ storage, home, signingKey, now: () => clock, usage });
  let computers = make();
  const claims = { pool: "pool-a", owner: "owner", organization: "org" };
  async function action(action: string, user: string, extra: Json = {}) {
    const intent = await signIntent(signingKey, { ...claims, user, expiresAt: clock + setupTtl });
    const envelope = await signEnvelope(signingKey, "sbs1", { action, user, intent, expiresAt: clock + 10_000, ...extra });
    return computers.handle(new Request(`https://pool.test/__setup/v1/${action}`, { method: "POST", body: JSON.stringify({ envelope }) }));
  }
  async function cap(pool = "pool-a", weekly: number | null = 1) {
    const intent = await signIntent(signingKey, { ...claims, pool, user: "owner", expiresAt: clock + setupTtl });
    return action("cap", "owner", { intent, member: "member", weekly });
  }
  async function access(users: string[]) {
    const envelope = await signEnvelope(signingKey, accessPrefix, { action: "audience", at: clock, expiresAt: clock + 10_000,
      pools: [{ ...claims, name: "A", users }] });
    return computers.access(new Request("https://pool.test/pool/v1/access", { method: "POST", body: JSON.stringify({ envelope }) }));
  }
  return { client, home, users, keys, calls, legacy, storage, cap, action, access,
    migrate: () => computers.migrateLegacy(), restart: () => { computers = make(); }, advance: (ms: number) => { clock += ms; },
    gate: (gate?: () => Promise<void>) => { patchGate = gate; }, fail: (key: number) => { failPatch = key; } };
}

function computer(pool = "pool-a"): Registry {
  return { computer: { id: "computer", name: "fixture", user: "member", pool,
    createdAt: "fixture", boundAt: "fixture", state: "active", keyId: 1, userId: 1, toolsKeyId: "fixture", toolsHash: "fixture",
    firstModelRequestAt: null, firstToolCallAt: null, revokedAt: null } };
}

test("legacy keys on two pools move with unchanged channels and the empty user is deleted", async () => {
  const f = await fixture();
  await f.migrate();
  for (const [index, pool] of ["pool-a", "pool-b"].entries()) {
    // Resolve the expected digest independently of the key write.
    assert.equal(f.users.find((row) => row.id === f.keys[index]!.user_id)?.username, await backendUserName("member", pool));
    assert.deepEqual(f.keys[index]!.channels, [index + 11]);
  }
  assert.ok(!f.users.some((user) => user.username === f.legacy));
  const writes = f.calls.filter((call) => call.method !== "GET").length;
  await f.migrate();
  assert.equal(f.calls.filter((call) => call.method !== "GET").length, writes);
});

test("non-pool, unrestricted and multi-group keys stay put and are logged", async (t) => {
  const f = await fixture(0), logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  f.keys.push(...[[13], [], [11, 12], [999]].map((channels, i) => ({ api_key_id: i + 1, user_id: 1, channels })));
  await f.migrate();
  assert.equal(logs.length, 4);
  assert.ok(f.keys.every((key) => key.user_id === 1));
  assert.ok(f.users.some((user) => user.username === f.legacy));
});

test("migration resumes across its 20-key budget and a partial backend failure", async () => {
  const f = await fixture(23);
  await f.migrate();
  assert.equal(f.keys.filter((key) => key.user_id === 1).length, 3);
  f.fail(22);
  await assert.rejects(f.migrate());
  assert.equal(f.keys.filter((key) => key.user_id === 1).length, 2);
  f.fail(0);
  await f.migrate();
  assert.equal(f.calls.filter((call) => call.method === "PATCH" && call.body?.api_key_id === 21).length, 1);
});

test("owner cap migrates inside the queue and refuses backend failures before setting a limit", async () => {
  const f = await fixture();
  await f.storage.put("computer-registry-v1", computer());
  f.fail(1);
  assert.equal((await f.cap()).status, 503);
  assert.ok(!f.calls.some((call) => call.method === "PATCH" && call.path.startsWith("/users/")));
  assert.equal(await readCap(f.client, "member", "pool-a"), null);
  f.fail(0);
  assert.equal((await f.cap()).status, 200);
  assert.equal(f.users.find((user) => user.id === f.keys[0]!.user_id)?.limit_7d_credits, 1);
  assert.equal(f.users.find((user) => user.id === f.keys[1]!.user_id)?.limit_7d_credits, null);
  assert.equal((await f.storage.get<Registry>("computer-registry-v1"))!.computer!.userId, f.keys[0]!.user_id);
});

test("person deletion revokes remaining legacy keys and removes their user", async () => {
  const f = await fixture();
  assert.equal(await f.home.deletePerson("member"), 2);
  assert.deepEqual(f.keys, []); assert.deepEqual(f.users, []);
});

test("cap reads never write or migrate, including a configured cap with remaining legacy keys", async (t) => {
  const f = await fixture();
  t.mock.method(console, "warn", () => {});
  f.users.push({ id: 5, username: await backendUserName("member", "pool-a"), limit_7d_credits: 1 });
  assert.equal(await readCap(f.client, "member", "pool-a"), null);
  assert.ok(f.keys.every((key) => key.user_id === 1));
  assert.ok(f.users.some((user) => user.id === 1));
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("a cap refuses remaining keys after the budget, then succeeds on retry", async () => {
  const f = await fixture(21);
  const response = await f.cap();
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /legacy keys still include this pool/);
  assert.equal(f.keys.filter((key) => key.user_id === 1).length, 1);
  assert.ok(!f.calls.some((call) => call.method === "PATCH" && call.path.startsWith("/users/")));
  assert.equal((await f.cap()).status, 200);
});

test("multi-group legacy keys block only cap writes for their groups, including clear", async (t) => {
  const f = await fixture(1);
  t.mock.method(console, "warn", () => {});
  f.keys[0]!.channels = [11, 12];
  for (const pool of ["pool-a", "pool-b"]) {
    assert.equal((await f.cap(pool)).status, 409);
    assert.equal((await f.cap(pool, null)).status, 409);
    assert.equal(await readCap(f.client, "member", pool), null);
  }
  assert.ok(!f.calls.some((call) => call.method === "PATCH"));
  assert.equal((await f.cap("pool-c")).status, 200);
  assert.deepEqual(f.keys[0]!.channels, [11, 12]);
  assert.equal(f.keys[0]!.user_id, 1);
});

test("alarm passes blocked users and repairs an interrupted registry save", async (t) => {
  const f = await fixture(1);
  f.keys[0]!.channels = [];
  f.users.push({ id: 10, username: `${brand.setup.id}-${await digest("other")}` });
  f.keys.push({ api_key_id: 10, user_id: 10, channels: [11] });
  t.mock.method(console, "warn", () => {});
  await f.migrate();
  assert.equal(f.storage.values.get("legacy-user-migration-cursor"), 1);
  await f.migrate();
  assert.ok(!f.users.some((user) => user.id === 10));
  f.keys[0]!.channels = [11];
  await f.storage.put("computer-registry-v1", computer());
  const put = f.storage.put.bind(f.storage);
  t.mock.method(f.storage, "put", async (key: string, value: unknown) => {
    if (key === "computer-registry-v1") throw Error("Interrupted save");
    return put(key, value);
  });
  await assert.rejects(f.migrate(), /Interrupted save/);
  assert.notEqual(f.keys[0]!.user_id, 1);
  t.mock.restoreAll();
  await f.migrate();
  assert.equal((await f.storage.get<Registry>("computer-registry-v1"))!.computer!.userId, f.keys[0]!.user_id);
});

test("finished migration skips all full lists durably until its daily recheck", async () => {
  const f = await fixture(1);
  await f.migrate();
  const before = f.calls.length;
  f.restart();
  for (let i = 0; i < 4; i++) { f.advance(300_000); await f.migrate(); }
  assert.equal(f.calls.length, before);
  f.advance(86_400_000);
  await f.migrate();
  assert.deepEqual(f.calls.slice(before).map((call) => call.path), ["/users"]);
  const after = f.calls.length;
  await f.migrate();
  assert.equal(f.calls.length, after);
});

test("registered binding chooses the user; migration preserves the channels it just read", async () => {
  const f = await fixture(1);
  await f.storage.put("computer-registry-v1", computer("pool-b"));
  await f.migrate();
  assert.deepEqual(f.keys[0]!.channels, [11]);
  const userId = f.keys[0]!.user_id;
  assert.equal(f.users.find((user) => user.id === userId)?.username, await backendUserName("member", "pool-b"));
  assert.equal((await f.storage.get<Registry>("computer-registry-v1"))!.computer!.userId, userId);
});

for (const entry of ["alarm", "cap"] as const) test(`gated ${entry} migration and switch serialize; removal from A leaves no key access on A`, async () => {
  const f = await fixture(1);
  await f.storage.put("computer-registry-v1", computer());
  assert.equal((await f.access(["owner", "member"])).status, 200);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.gate(async () => { entered(); await gate; });
  const migration = entry === "alarm" ? f.migrate() : f.cap();
  await started;
  const switching = f.action("switch", "member", { id: "computer", pool: "pool-b", own: { pool: "pool-b", organization: "org" } });
  let switched = false;
  void switching.then(() => { switched = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(switched, false);
  assert.equal(f.calls.filter((call) => call.method === "PATCH").length, 1);
  release();
  const result = await migration;
  if (result) assert.equal(result.status, 200);
  assert.equal((await switching).status, 200);
  f.gate();
  const registry = (await f.storage.get<Registry>("computer-registry-v1"))!;
  assert.equal(registry.computer!.pool, "pool-b");
  assert.equal(registry.computer!.userId, f.keys[0]!.user_id);
  assert.deepEqual(f.keys[0]!.channels, [12]);
  assert.equal((await f.access(["owner"])).status, 200);
  assert.ok(f.keys.every((key) => !(key.channels as number[]).includes(11)));
  assert.equal((await f.storage.get<Registry>("computer-registry-v1"))!.computer!.pool, "pool-b");
});
