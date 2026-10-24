import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { backendUserName, digest } from "./backend-users.ts";
import { Computers } from "./computers.ts";
import type { Registry } from "./computer-registry.ts";
import { ComputerHome } from "./computer-home.ts";
import { HomeClient, poolGroupPrefix } from "./control.ts";
import { readCap, setCap } from "./caps.ts";
import { ControlFailure, type Json } from "./json.ts";

async function fixture(count = 2) {
  const legacy = `${brand.setup.id}-${await digest("member")}`;
  const users: Json[] = [{ id: 1, username: legacy, credits_unlimited: true }];
  const keys: Json[] = Array.from({ length: count }, (_, i) => ({ api_key_id: i + 1, user_id: 1, channels: [i % 2 + 11] }));
  const calls: { path: string; method: string; body?: Json }[] = [];
  let nextId = 2, failPatch = 0;
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
  return { client, home: new ComputerHome(client), users, keys, calls, legacy, fail: (key: number) => { failPatch = key; } };
}

test("legacy keys on two pools move with unchanged channels and the empty user is deleted", async () => {
  const f = await fixture();
  assert.equal((await f.home.migrateLegacy("member")).complete, true);
  for (const [index, pool] of ["pool-a", "pool-b"].entries()) {
    // Resolve the expected digest independently of the key write.
    assert.equal(f.users.find((row) => row.id === f.keys[index]!.user_id)?.username, await backendUserName("member", pool));
    assert.deepEqual(f.keys[index]!.channels, [index + 11]);
  }
  assert.ok(!f.users.some((user) => user.username === f.legacy));
  const writes = f.calls.filter((call) => call.method !== "GET").length;
  await f.home.migrateLegacy("member");
  assert.equal(f.calls.filter((call) => call.method !== "GET").length, writes);
});

test("non-pool, unrestricted and multi-group keys stay put and are logged", async (t) => {
  const f = await fixture(0), logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  f.keys.push(...[[13], [], [11, 12], [999]].map((channels, i) => ({ api_key_id: i + 1, user_id: 1, channels })));
  assert.equal((await f.home.migrateLegacy("member")).complete, false);
  assert.equal(logs.length, 4);
  assert.ok(f.keys.every((key) => key.user_id === 1));
  assert.ok(f.users.some((user) => user.username === f.legacy));
});

test("migration resumes across its 20-key budget and a partial backend failure", async () => {
  const f = await fixture(23);
  assert.equal((await f.home.migrateLegacy("member")).complete, false);
  assert.equal(f.keys.filter((key) => key.user_id === 1).length, 3);
  f.fail(22);
  await assert.rejects(f.home.migrateLegacy("member"));
  assert.equal(f.keys.filter((key) => key.user_id === 1).length, 2);
  f.fail(0);
  assert.equal((await f.home.migrateLegacy("member")).complete, true);
  assert.equal(f.calls.filter((call) => call.method === "PATCH" && call.body?.api_key_id === 21).length, 1);
});

test("setCap migrates first, caps the owning user and fails retryably on migration failure", async () => {
  const f = await fixture();
  f.fail(1);
  await assert.rejects(setCap(f.client, "member", "pool-a", 1), (error: unknown) => error instanceof ControlFailure && error.status === 503);
  assert.ok(!f.calls.some((call) => call.method === "PATCH" && call.path.startsWith("/users/")));
  await assert.rejects(readCap(f.client, "member", "pool-a"));
  f.fail(0);
  await setCap(f.client, "member", "pool-a", 1);
  assert.equal(f.users.find((user) => user.id === f.keys[0]!.user_id)?.limit_7d_credits, 1);
  assert.equal(f.users.find((user) => user.id === f.keys[1]!.user_id)?.limit_7d_credits, null);
});

test("person deletion revokes remaining legacy keys and removes their user", async () => {
  const f = await fixture();
  assert.equal(await f.home.deletePerson("member"), 2);
  assert.deepEqual(f.keys, []); assert.deepEqual(f.users, []);
});

test("cap reads migrate legacy keys before returning an uncapped value", async () => {
  const f = await fixture();
  assert.equal(await readCap(f.client, "member", "pool-a"), null);
  assert.ok(f.keys.every((key) => key.user_id !== 1));
  assert.ok(!f.users.some((user) => user.id === 1));
});

test("a cap stays retryable until all keys move, including skipped keys", async (t) => {
  const f = await fixture(21);
  await assert.rejects(setCap(f.client, "member", "pool-a", 1), (error: unknown) =>
    error instanceof ControlFailure && error.status === 503 && error.retryAfterSeconds === 5);
  assert.equal(f.keys.filter((key) => key.user_id === 1).length, 1);
  await setCap(f.client, "member", "pool-a", 1);
  const skipped = await fixture(1);
  skipped.keys[0]!.channels = [];
  t.mock.method(console, "warn", () => {});
  await assert.rejects(setCap(skipped.client, "member", "pool-a", 1));
  assert.ok(!skipped.calls.some((call) => call.method === "PATCH" && call.path.startsWith("/users/")));
});

test("alarm cursor passes blocked users, wraps and repairs registry writes after cap migration", async (t) => {
  const f = await fixture(1);
  f.keys[0]!.channels = [];
  f.users.push({ id: 10, username: `${brand.setup.id}-${await digest("other")}` });
  f.keys.push({ api_key_id: 10, user_id: 10, channels: [11] });
  t.mock.method(console, "warn", () => {});
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
  };
  const computers = new Computers({ storage, home: f.home, signingKey: "fixture" });
  await computers.migrateLegacy();
  assert.equal(values.get("legacy-user-migration-cursor"), 1);
  await computers.migrateLegacy();
  assert.ok(!f.users.some((user) => user.id === 10));
  f.keys[0]!.channels = [11];
  await setCap(f.client, "member", "pool-a", 1);
  // The cap path cannot write the registry. The next alarm repairs its acknowledged key id.
  const registry: Registry = { computer: { id: "computer", name: "fixture", user: "member", pool: "pool-a",
    createdAt: "fixture", boundAt: "fixture", state: "active", keyId: 1, userId: 1, toolsKeyId: "fixture", toolsHash: "fixture",
    firstModelRequestAt: null, firstToolCallAt: null, revokedAt: null } };
  await storage.put("computer-registry-v1", registry);
  await computers.migrateLegacy();
  assert.equal((await storage.get<Registry>("computer-registry-v1"))!.computer!.userId, f.keys[0]!.user_id);
  assert.equal(values.get("legacy-user-migration-cursor"), 0);
});
