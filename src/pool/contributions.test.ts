import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolView, SignInStarted } from "../../apps/pool/contract.ts";
import { HomeClient } from "./control.ts";
import { ComputerHome } from "./computer-home.ts";
import { Computers } from "./computers.ts";
import { accessGrace, accessPrefix, accessTtl, type AccessChange } from "./access-contract.ts";
import { signEnvelope, signPoolToken } from "./token.ts";
import { fixture, error, status, state, provider, signingKey } from "./test/control.ts";

async function contribute(f: Awaited<ReturnType<typeof fixture>>, caller: string, pool = "pool-a") {
  const response = await f.call("/login-files", { pool, caller, body: { type: provider, refresh_token: `fixture-${caller}` } });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { accountId: string }).accountId;
}

for (const flow of ["device", "callback"] as const) {
  test(`member ${flow} sign-in retains its starter as addedBy through restart and another caller's poll`, async () => {
    const f = await fixture(); f.home.flow = flow;
    const started = await (await f.call("/sign-ins", { owner: false, body: { provider } })).json() as SignInStarted;
    if (flow === "callback") assert.equal((await f.callback(started)).status, 200);
    f.restart();
    f.home.addFile("member-sign-in");
    Object.assign(f.home.sessions.get(state(started))!, { status: "ok" });
    await status(await f.poll(started), { status: "connected", accountId: "member-sign-in" });
    const view = await (await f.call("/pool", { owner: false })).json() as PoolView;
    assert.equal(view.accounts[0]?.addedBy, "fake-member");
    assert.equal((await f.call("/accounts/member-sign-in", { method: "DELETE", owner: false })).status, 200);
  });
}

test("login-file contributors persist; members remove their own, owners remove any, legacy stays owner-only", async () => {
  const f = await fixture();
  const ownerAccount = await contribute(f, "fake-owner");
  const memberAccount = await contribute(f, "fake-member");
  f.home.addFile("legacy");
  f.home.members.push({ id: 90, channel_group_id: f.home.groups[0]!.id, auth_id: "legacy" });
  f.restart();
  const view = await (await f.call("/pool", { owner: false })).json() as PoolView;
  assert.deepEqual(Object.fromEntries(view.accounts.map((row) => [row.id, row.addedBy])), {
    [ownerAccount]: "fake-owner", [memberAccount]: "fake-member", legacy: null,
  });
  for (const id of [ownerAccount, "legacy"]) {
    const response = await f.call(`/accounts/${id}`, { method: "DELETE", owner: false });
    assert.equal((await response.clone().json() as { message: string }).message,
      "Only the pool's owner or the person who added it can remove this subscription.");
    await error(response, "not_owner", 403);
    assert.ok(f.home.files.has(id));
  }
  assert.equal((await f.call(`/accounts/${memberAccount}`, { method: "DELETE", owner: false })).status, 200);
  const another = await contribute(f, "fake-member");
  for (const id of [ownerAccount, another, "legacy"]) assert.equal((await f.call(`/accounts/${id}`, { method: "DELETE" })).status, 200);
  assert.equal(f.home.files.size, 0);
});

test("contribution endpoints require a caller before Home or attribution storage", async () => {
  const f = await fixture();
  for (const [path, method] of [["/sign-ins", "POST"], ["/sign-ins/status", "GET"], ["/sign-ins/callback", "POST"], ["/sign-ins", "DELETE"], ["/login-files", "POST"]]) {
    await error(await f.call(path!, { method, caller: null }), "unauthorized", 401);
  }
  assert.equal(f.home.calls.length, 0); assert.equal(f.storage.gets, 0);
});

async function accessFixture() {
  const f = await fixture();
  const backend = new ComputerHome(new HomeClient(f.home.fetch));
  backend.user = async () => 1;
  backend.deletePerson = async () => 0;
  const computers = new Computers({ storage: f.storage, home: backend, signingKey, now: f.now, contributions: f.contributions });
  const audience = (users: string[]) => ({ action: "audience" as const,
    pools: [{ pool: "pool-a", owner: "fake-owner", organization: "fake-org", name: "Pool", users }] });
  const access = async (change: AccessChange) => {
    const at = f.now();
    const envelope = await signEnvelope(signingKey, accessPrefix, { ...change, at, expiresAt: at + accessTtl });
    return computers.access(new Request("https://pool.example/pool/v1/access", { method: "POST", body: JSON.stringify({ envelope }) }));
  };
  assert.equal((await access(audience(["fake-owner", "fake-member"])) ).status, 200);
  const own = await contribute(f, "fake-owner");
  const member = await contribute(f, "fake-member");
  const second = await contribute(f, "fake-member");
  return { ...f, access, audience, own, member, second };
}

test("callerless durable removal deletes only recorded contributions whose person left the audience", async () => {
  const f = await accessFixture();
  f.home.addFile("legacy");
  f.home.members.push({ id: 90, channel_group_id: f.home.groups[0]!.id, auth_id: "legacy" });
  const remove = (id: string, token?: string) => f.call(`/accounts/${id}`, { method: "DELETE", caller: null, token });
  for (const id of [f.member, f.own, "legacy", "unknown"]) await error(await remove(id), "unauthorized", 401);
  assert.ok(f.home.files.has(f.member));
  assert.equal((await f.access(f.audience(["fake-owner"]))).status, 200);
  assert.ok(!f.home.members.some((row) => row.auth_id === f.member));
  assert.ok(f.home.files.has(f.member), "Departure detaches before durable removal");
  f.restart();
  await error(await remove(f.member, "invalid-token"), "unauthorized", 401);
  for (const id of [f.own, "legacy"]) await error(await remove(id), "unauthorized", 401);
  assert.equal((await remove(f.member)).status, 200);
  assert.ok(!f.home.files.has(f.member));
  assert.ok(f.home.files.has(f.own)); assert.ok(f.home.files.has("legacy"));
  f.advance(accessGrace + 1);
  assert.equal((await f.access(f.audience(["fake-owner", "fake-member"]))).status, 200);
  f.restart();
  const fresh = await contribute(f, "fake-member");
  await error(await remove(fresh), "unauthorized", 401);
  assert.ok(f.home.files.has(fresh));
  assert.equal((await remove(f.second)).status, 200, "Old departure cleanup survives re-sharing and restart");
  assert.ok(!f.home.files.has(f.second));
  assert.ok(f.home.files.has(fresh));
});

test("tool login-file uploads are owner-only; Accounts uploads allow members", async () => {
  const f = await fixture();
  const denied = await f.call("/login-files/tool", { caller: "fake-member", body: { type: provider } });
  assert.equal((await denied.clone().json() as { message: string }).message,
    "Only the pool's owner can upload login files with this tool. Use Accounts → Connect new account to add your subscription.");
  await error(denied, "not_owner", 403);
  assert.equal(f.home.calls.length, 0);
  assert.equal(f.storage.gets, 0);
  const ownerUpload = await f.call("/login-files/tool", { body: { type: provider } });
  assert.equal(ownerUpload.status, 200);
  const own = (await ownerUpload.json() as { accountId: string }).accountId;
  const member = await contribute(f, "fake-member");
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.equal(view.accounts.find((row) => row.id === own)?.addedBy, "fake-owner");
  assert.equal(view.accounts.find((row) => row.id === member)?.addedBy, "fake-member");
});

test("callerless removal fails closed without a directory and for a departed pool owner", async () => {
  const f = await fixture();
  const id = await contribute(f, "fake-member");
  await error(await f.call(`/accounts/${id}`, { method: "DELETE", caller: null }), "unauthorized", 401);
  assert.ok(f.home.files.has(id));
  const departed = await accessFixture();
  assert.equal((await departed.access({ action: "pool-deleted", pool: "pool-a" })).status, 200);
  await error(await departed.call(`/accounts/${departed.own}`, { method: "DELETE", caller: null }), "unauthorized", 401);
  assert.ok(departed.home.files.has(departed.own));
  assert.equal((await departed.call(`/accounts/${departed.member}`, { method: "DELETE", caller: null })).status, 200);
});

test("pre-upgrade signed departure evidence survives re-sharing and failed durable removal", async () => {
  const f = await accessFixture();
  assert.equal((await f.access(f.audience(["fake-owner"]))).status, 200);
  const saved = await f.storage.get<{ accounts: Record<string, { departed?: boolean }> }>("pool-contributions-v1");
  assert.ok(saved);
  for (const record of Object.values(saved.accounts)) delete record.departed;
  await f.storage.put("pool-contributions-v1", saved);
  f.restart(); f.advance(accessGrace + 1);
  assert.equal((await f.access(f.audience(["fake-owner", "fake-member"]))).status, 200);
  f.home.override = (path, init) => path.includes("/channel-group-details/") && init?.method === "DELETE"
    ? Response.json({}, { status: 503 }) : undefined;
  assert.equal((await f.call(`/accounts/${f.member}`, { method: "DELETE", caller: null })).status, 503);
  f.home.override = undefined; f.restart();
  assert.equal((await f.call(`/accounts/${f.member}`, { method: "DELETE", caller: null })).status, 200);
  const fresh = await contribute(f, "fake-member");
  await error(await f.call(`/accounts/${fresh}`, { method: "DELETE", caller: null }), "unauthorized", 401);
});

test("pool identity is visible only to the owner and each account's contributor; capacity stays visible", async () => {
  const f = await fixture();
  const contributors = ["fake-owner", "fake-member", "other-member"];
  const ids = await Promise.all(contributors.map((caller) => contribute(f, caller)));
  f.home.addFile("legacy");
  f.home.members.push({ id: 90, channel_group_id: f.home.groups[0]!.id, auth_id: "legacy" });
  ids.push("legacy");
  for (const id of ids) {
    f.home.files.get(id)!.email = `${id}@example.invalid`;
    f.home.files.get(id)!.status_message = `Sign in again as ${id}@example.invalid`;
    f.home.quota.push({ credential_id: id, plan: { name: `Plan ${id}` }, primary_windows: [
      { id: "weekly", scope: "account", label: "Weekly", remaining_ratio: 0.5, window_seconds: 604800 },
    ] });
  }
  f.restart();
  const owner = await (await f.call("/pool")).json() as PoolView;
  for (const caller of ["fake-member", "other-member", null]) {
    const view = await (await f.call("/pool", { caller })).json() as PoolView;
    assert.equal(view.isOwner, false);
    assert.equal(view.accounts.length, ids.length);
    for (const account of view.accounts) {
      const original = owner.accounts.find((row) => row.id === account.id)!;
      assert.equal(original.label, `${account.id}@example.invalid`);
      assert.equal(original.plan, `Plan ${account.id}`);
      assert.equal(original.message, `Sign in again as ${account.id}@example.invalid`);
      const own = caller !== null && contributors[ids.indexOf(account.id)] === caller;
      assert.equal(account.label, own ? original.label : "");
      assert.equal(account.plan, own ? original.plan : null);
      assert.equal(account.message, own ? original.message : null);
      assert.deepEqual(account.windows, original.windows);
      assert.equal(account.windows[0]?.remainingRatio, 0.5);
      assert.equal(account.state, "active");
      assert.deepEqual({ ...account, label: original.label, plan: original.plan, message: original.message }, original);
    }
  }
});

test("audience detaches exactly the departing member's credentials before 200; re-share restores them", async () => {
  const f = await accessFixture();
  const group = f.home.groups[0]!.id;
  const before = f.home.calls.length;
  assert.equal((await f.access(f.audience(["fake-owner"]))).status, 200);
  assert.deepEqual(f.home.members.map((row) => row.auth_id), [f.own]);
  assert.ok(f.home.files.has(f.member)); assert.ok(f.home.files.has(f.second));
  assert.equal(f.home.calls.slice(before).filter((call) => call.method === "DELETE" && call.path.includes("/channel-group-details/")).length, 2);
  f.restart();
  f.advance(accessGrace + 1);
  assert.equal((await f.access(f.audience(["fake-owner", "fake-member"]))).status, 200);
  assert.deepEqual(new Set(f.home.members.filter((row) => row.channel_group_id === group).map((row) => row.auth_id)), new Set([f.own, f.member, f.second]));
});

test("failed detach fails access; rollback restores partial deletes without a computer, after restart", async () => {
  const f = await accessFixture();
  const failed = f.home.members.find((row) => row.auth_id === f.second)!;
  f.home.override = (path, init) => path.endsWith(`/channel-group-details/${failed.id}`) && init?.method === "DELETE"
    ? Response.json({ error: "fixture failure" }, { status: 503 }) : undefined;
  assert.equal((await f.access(f.audience(["fake-owner"]))).status, 503);
  assert.ok(!f.home.members.some((row) => row.auth_id === f.member));
  assert.ok(f.home.members.some((row) => row.auth_id === f.second));
  f.home.override = undefined; f.restart(); f.advance(1);
  assert.equal((await f.access(f.audience(["fake-owner", "fake-member"]))).status, 200);
  assert.deepEqual(new Set(f.home.members.map((row) => row.auth_id)), new Set([f.own, f.member, f.second]));
});

for (const action of ["person-deleted", "pool-deleted"] as const) {
  test(`${action} detaches contributions, retains them for durable remove, and supports rollback after grace`, async () => {
    const f = await accessFixture();
    const change = action === "person-deleted" ? { action, user: "fake-member" } : { action, pool: "pool-a" };
    assert.equal((await f.access(change)).status, 200);
    assert.deepEqual(f.home.members.map((row) => row.auth_id), action === "person-deleted" ? [f.own] : []);
    assert.ok(f.home.files.has(f.member));
    assert.equal((await f.call(`/accounts/${f.member}`, { method: "DELETE", owner: false })).status, 200);
    assert.ok(!f.home.files.has(f.member));
    f.restart(); f.advance(accessGrace + 1);
    assert.equal((await f.access(f.audience(["fake-owner", "fake-member"]))).status, 200);
    assert.deepEqual(new Set(f.home.members.map((row) => row.auth_id)), new Set([f.own, f.second]));
  });
}

test("an in-flight sign-in completed after departure stays detached and keeps its contributor for durable cleanup", async () => {
  const f = await accessFixture(); f.home.flow = "device";
  const started = await (await f.call("/sign-ins", { owner: false, body: { provider } })).json() as SignInStarted;
  assert.equal((await f.access(f.audience(["fake-owner"]))).status, 200);
  f.home.addFile("late-member");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok" });
  await status(await f.poll(started), { status: "connected", accountId: "late-member" });
  assert.ok(!f.home.members.some((row) => row.auth_id === "late-member"));
  assert.equal((await f.call("/accounts/late-member", { method: "DELETE", owner: false })).status, 200);
});

test("a successful removal keeps stale audiences blocked during grace", async () => {
  const f = await accessFixture();
  assert.equal((await f.access(f.audience(["fake-owner"]))).status, 200);
  f.advance(1);
  assert.equal((await f.access(f.audience(["fake-owner", "fake-member"]))).status, 200);
  assert.deepEqual(f.home.members.map((row) => row.auth_id), [f.own]);
});

test("access waits for Home's membership deletion and serializes a racing contribution behind it", async () => {
  const f = await accessFixture();
  let entered!: () => void; let release!: () => void;
  const deleting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.home.override = async (path, init) => {
    if (path.includes("/channel-group-details/") && init?.method === "DELETE") { entered(); await gate; }
    return undefined;
  };
  let answered = false;
  const removal = f.access(f.audience(["fake-owner"])).then((response) => { answered = true; return response; });
  await deleting;
  const racing = contribute(f, "fake-member");
  assert.equal(answered, false, "Access cannot acknowledge before Home's delete completes");
  release();
  assert.equal((await removal).status, 200);
  const id = await racing;
  assert.ok(f.home.files.has(id));
  assert.ok(!f.home.members.some((row) => row.auth_id === id), "A queued call cannot reattach a departed person's account");
});

test("deleting the pool owner also detaches members' contributions, while another pool stays intact", async () => {
  const f = await accessFixture();
  const token = await signPoolToken(signingKey, { pool: "pool-b", owner: "another-owner", organization: "other-org" });
  const response = await f.call("/login-files", { pool: "pool-b", token, owner: false, body: { type: provider } });
  assert.equal(response.status, 200);
  const elsewhere = (await response.json() as { accountId: string }).accountId;
  assert.equal((await f.access({ action: "person-deleted", user: "fake-owner" })).status, 200);
  assert.deepEqual(f.home.members.map((row) => row.auth_id), [elsewhere]);
});

test("a detached credential remains reserved to its pool during another pool's sign-in", async () => {
  const f = await accessFixture();
  assert.equal((await f.access(f.audience(["fake-owner"]))).status, 200);
  f.home.flow = "device";
  const started = await f.start("pool-b");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: f.member });
  const response = await f.poll(started, "pool-b");
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "failed");
  assert.ok(!f.home.members.some((row) => row.auth_id === f.member));
});

test("failed final membership cleanup retains contributor authority for retry", async () => {
  const f = await fixture(); const id = await contribute(f, "fake-member");
  f.home.override = (path, init) => path.includes("/channel-group-details/") && init?.method === "DELETE"
    ? Response.json({ error: "synthetic failure" }, { status: 500 }) : undefined;
  assert.equal((await f.call(`/accounts/${id}`, { method: "DELETE", owner: false })).status, 503);
  assert.ok(!f.home.files.has(id));
  f.restart(); f.home.override = undefined;
  assert.equal((await f.call(`/accounts/${id}`, { method: "DELETE", owner: false })).status, 200);
  assert.deepEqual(f.home.members, []);
});
