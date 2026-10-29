import assert from "node:assert/strict";
import { test } from "node:test";
import { accessGrace, accessPrefix, accessTtl, type AccessChange } from "./access-contract.ts";
import { ComputerHome } from "./computer-home.ts";
import { Computers } from "./computers.ts";
import { HomeClient } from "./control.ts";
import { PoolDirectory } from "./directory.ts";
import { signEnvelope } from "./token.ts";
import { error, fixture, provider, signingKey } from "./test/control.ts";

const owner = "fake-owner", member = "fake-member";
const audience = (pool: string, users: string[]) => ({ pool, users, owner, organization: "fake-org", name: "Pool" });

async function accessFixture() {
  const f = await fixture();
  const backend = new ComputerHome(new HomeClient(f.home.fetch));
  backend.user = async () => 1;
  backend.deletePerson = async () => 0;
  const computers = new Computers({ storage: f.storage, home: backend, signingKey, now: f.now, contributions: f.contributions });
  async function access(change: AccessChange) {
    const at = f.now();
    const envelope = await signEnvelope(signingKey, accessPrefix, { ...change, at, expiresAt: at + accessTtl });
    return computers.access(new Request("https://pool.example/pool/v1/access", { method: "POST", body: JSON.stringify({ envelope }) }));
  }
  async function contribute(pool: string) {
    const response = await f.call("/login-files", { pool, caller: member, body: { type: provider } });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { accountId: string }).accountId;
  }
  return { ...f, access, contribute };
}

for (const source of ["token", "own"] as const) {
  test(`${source} setup context cannot authorize callerless contribution deletion`, async () => {
    const f = await accessFixture();
    const directory = await PoolDirectory.load(f.storage, f.now());
    const claims = { pool: "pool-a", owner, organization: "fake-org" };
    if (source === "token") await directory.learn(claims, owner);
    else await directory.learnOwn(claims, owner, f.now());
    const id = await f.contribute("pool-a");
    assert.ok(f.home.members.some((row) => row.auth_id === id));
    f.restart();
    await error(await f.call(`/accounts/${id}`, { method: "DELETE", caller: null }), "unauthorized", 401);
    assert.ok(f.home.files.has(id));
    assert.ok(f.home.members.some((row) => row.auth_id === id));
  });

  test(`${source} setup context never detaches or suspends contributions on another pool's access change`, async () => {
    const f = await accessFixture();
    const directory = await PoolDirectory.load(f.storage, f.now());
    const claims = { pool: "pool-a", owner, organization: "fake-org" };
    if (source === "token") await directory.learn(claims, owner);
    else await directory.learnOwn(claims, owner, f.now());
    const first = await f.contribute("pool-a");
    assert.equal((await f.access({ action: "audience", pools: [audience("pool-b", [owner])] })).status, 200);
    assert.ok(f.home.members.some((row) => row.auth_id === first));
    f.restart();
    const second = await f.contribute("pool-a");
    assert.ok(f.home.members.some((row) => row.auth_id === second));
    // A signed full audience is authoritative even if setup knew only its owner.
    assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner])] })).status, 200);
    assert.ok(!f.home.members.some((row) => row.auth_id === first || row.auth_id === second));
    assert.ok(f.home.files.has(first) && f.home.files.has(second));
  });
}

test("a signed audience excluding the contributor authorizes callerless deletion after setup", async () => {
  const f = await accessFixture();
  const directory = await PoolDirectory.load(f.storage, f.now());
  await directory.learn({ pool: "pool-a", owner, organization: "fake-org" }, owner);
  const id = await f.contribute("pool-a");
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner])] })).status, 200);
  assert.ok(f.home.files.has(id));
  f.restart();
  assert.equal((await f.call(`/accounts/${id}`, { method: "DELETE", caller: null })).status, 200);
  assert.ok(!f.home.files.has(id));
});

test("signed person deletion authorizes callerless contribution deletion with setup-only context", async () => {
  const f = await accessFixture();
  const directory = await PoolDirectory.load(f.storage, f.now());
  await directory.learnOwn({ pool: "pool-a", owner, organization: "fake-org" }, owner, f.now());
  const id = await f.contribute("pool-a");
  assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
  assert.ok(f.home.files.has(id));
  f.restart();
  assert.equal((await f.call(`/accounts/${id}`, { method: "DELETE", caller: null })).status, 200);
  assert.ok(!f.home.files.has(id));
});

test("deleting a pool known only through setup detaches its contributions", async () => {
  const f = await accessFixture();
  const directory = await PoolDirectory.load(f.storage, f.now());
  await directory.learnOwn({ pool: "pool-a", owner, organization: "fake-org" }, owner, f.now());
  const id = await f.contribute("pool-a");
  assert.equal((await f.access({ action: "pool-deleted", pool: "pool-a" })).status, 200);
  assert.ok(!f.home.members.some((row) => row.auth_id === id));
  const later = await f.contribute("pool-a");
  assert.ok(!f.home.members.some((row) => row.auth_id === later));
});

test("a restore failure stays pending without blocking another pool's detach or later access", async () => {
  const f = await accessFixture();
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member]), audience("pool-b", [owner, member])] })).status, 200);
  const first = await f.contribute("pool-a"), second = await f.contribute("pool-a");
  const other = await f.contribute("pool-b");
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner])] })).status, 200);
  f.advance(accessGrace + 1);
  f.home.override = (path) => path === "/v8/management/credentials" ? Response.json({}, { status: 503 }) : undefined;
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member]), audience("pool-b", [owner])] })).status, 200);
  assert.ok(!f.home.members.some((row) => [first, second, other].includes(row.auth_id)));
  f.restart();
  const before = f.home.calls.length;
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-b", [owner])] })).status, 200);
  assert.ok(!f.home.calls.slice(before).some((call) => call.path === "/v8/management/credentials"), "Another pool must not attempt the pending restore");
  f.home.override = undefined;
  const restoring = f.home.calls.length;
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member])] })).status, 200);
  assert.deepEqual(new Set(f.home.members.map((row) => row.auth_id)), new Set([first, second]));
  const calls = f.home.calls.slice(restoring);
  assert.equal(calls.filter((call) => call.path === "/v8/management/credentials").length, 1);
  assert.equal(calls.filter((call) => call.path.startsWith("/v8/management/channel-group-details?")).length, 1);
});

test("reconciliation batches detaches per pool and fails access when a detach fails", async () => {
  const f = await accessFixture();
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member])] })).status, 200);
  const first = await f.contribute("pool-a"), second = await f.contribute("pool-a");
  const failing = f.home.members.find((row) => row.auth_id === second)!;
  f.home.override = (path, init) => path.endsWith(`/channel-group-details/${failing.id}`) && init?.method === "DELETE"
    ? Response.json({}, { status: 503 }) : undefined;
  const before = f.home.calls.length;
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner])] })).status, 503);
  assert.ok(!f.home.members.some((row) => row.auth_id === first));
  assert.ok(f.home.members.some((row) => row.auth_id === second));
  assert.equal(f.home.calls.slice(before).filter((call) => call.path.startsWith("/v8/management/channel-group-details?")).length, 1);
  f.home.override = undefined;
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner])] })).status, 200);
  assert.equal(f.home.members.length, 0);
});

test("restoring a deleted person in one pool does not restore their access to another pool", async () => {
  const f = await accessFixture();
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member]), audience("pool-b", [owner, member])] })).status, 200);
  const id = await f.contribute("pool-a");
  assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
  assert.ok(!f.home.members.some((row) => row.auth_id === id));
  f.advance(accessGrace + 1);
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-b", [owner, member])] })).status, 200);
  const later = await f.contribute("pool-a");
  assert.ok(!f.home.members.some((row) => row.auth_id === id || row.auth_id === later));
});

test("failed membership restoration remains suspended until the same pool retries", async () => {
  const f = await accessFixture();
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member])] })).status, 200);
  const id = await f.contribute("pool-a");
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner])] })).status, 200);
  f.advance(accessGrace + 1);
  f.home.override = (path, init) => path === "/v8/management/channel-group-details" && init?.method === "POST"
    ? Response.json({}, { status: 503 }) : undefined;
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member])] })).status, 200);
  assert.ok(!f.home.members.some((row) => row.auth_id === id));
  f.restart(); f.home.override = undefined;
  assert.equal((await f.access({ action: "audience", pools: [audience("pool-a", [owner, member])] })).status, 200);
  assert.ok(f.home.members.some((row) => row.auth_id === id));
});
