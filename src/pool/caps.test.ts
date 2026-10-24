import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName, personPrefix } from "./backend-users.ts";
import { HomeClient, poolGroupPrefix } from "./control.ts";
import { readCap, readCaps, setCap } from "./caps.ts";

async function fixture() {
  const users: Record<string, unknown>[] = [{ id: 1, username: await backendUserName("member", "pool"), limit_7d_credits: 10 }];
  const keys: Record<string, unknown>[] = [];
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const home = new HomeClient(async (raw, init) => {
    const path = raw.replace("/v8/management", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/users") {
      if (method === "POST") users.push({ id: users.length + 1, ...body });
      return Response.json({ users });
    }
    if (path === "/access/api-keys") return Response.json({ items: keys });
    if (path === "/channel-groups") return Response.json({ channel_groups: [
      { id: 11, channel_name: `${poolGroupPrefix}pool` }, { id: 12, channel_name: `${poolGroupPrefix}other` },
    ] });
    const user = users.find((user) => path.startsWith(`/users/${user.id}`));
    assert.ok(user);
    if (method === "PATCH") { Object.assign(user, body); return Response.json({ user }); }
    return Response.json({ timezone: "UTC", windows: [{ id: "7d", enabled: user.limit_7d_credits != null,
      limit: user.limit_7d_credits, used: 3, remaining: 7, mode: "calendar", week_reset_day: 1, week_reset_hour: 0,
      reset_at: "2026-10-26T00:00:00Z" }] });
  });
  return { home, users, calls, keys };
}

test("cap uses a Monday UTC calendar week, clears with null, and creates missing pool users", async () => {
  const f = await fixture();
  await setCap(f.home, "member", "pool", 10);
  assert.deepEqual(f.calls.find((call) => call.method === "PATCH")?.body, {
    limit_7d_credits: 10, window_mode_7d: "calendar", timezone: "UTC", week_reset_day: 1, week_reset_hour: 0,
  });
  assert.deepEqual(await readCap(f.home, "member", "pool"), { weekly: 10, used: 3, remaining: 7, resetAt: "2026-10-26T00:00:00Z" });
  await setCap(f.home, "member", "pool", null);
  assert.equal(await readCap(f.home, "member", "pool"), null);
  await setCap(f.home, "member", "own-pool", 5);
  assert.equal(f.users.length, 2);
  assert.equal(f.users[1]!.username, await backendUserName("member", "own-pool"));
  assert.equal(f.users[1]!.credits_unlimited, true);
});

test("invalid cap amounts fail before any Home write, including sub-cent values", async () => {
  const f = await fixture();
  for (const amount of [NaN, Infinity, -Infinity, 0, -1, 100000.01, 0.001, 0.00000000001, 1.00000000000001, 1.234]) await assert.rejects(setCap(f.home, "member", "pool", amount));
  assert.equal(f.calls.length, 0);
  for (const amount of [0.01, 0.29, 100000]) await setCap(f.home, "member", "pool", amount);
});

test("bulk reads list users once, skip missing and uncapped members and deduplicate people", async () => {
  const f = await fixture();
  f.users.push({ id: 2, username: await backendUserName("other", "pool"), limit_7d_credits: null });
  const result = await readCaps(f.home, "pool", ["member", "other", "missing", "member"]);
  assert.equal(result.get("member")?.used, 3);
  assert.equal(result.get("other"), null);
  assert.equal(result.get("missing"), null);
  assert.equal(f.calls.filter((call) => call.path === "/users").length, 1);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/period-limits")).length, 1);
  assert.deepEqual(await readCaps(f.home, "pool", []), new Map());
});


test("legacy keys suppress only the cap of the person and pool they still include", async (t) => {
  const f = await fixture();
  t.mock.method(console, "warn", () => {});
  f.users.push({ id: 9, username: (await personPrefix("member")).slice(0, -1) });
  f.keys.push({ api_key_id: 3, user_id: 9, channels: [11, 12] });
  assert.equal(await readCap(f.home, "member", "pool"), null);
  assert.ok(!f.calls.some((call) => call.path.endsWith("/period-limits")));
  f.keys[0]!.channels = [12];
  assert.equal((await readCap(f.home, "member", "pool"))!.weekly, 10);
  f.keys[0]!.user_id = 99;
  f.keys[0]!.channels = [11];
  assert.equal((await readCap(f.home, "member", "pool"))!.used, 3);
  assert.ok(f.calls.every((call) => call.method === "GET"));
});
