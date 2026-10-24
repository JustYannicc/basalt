import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { PoolDirectory } from "./directory.ts";
import { accessGrace } from "./access-contract.ts";
import { setupTtl } from "./setup-links.ts";
import { Computers } from "./computers.ts";
import { signEnvelope } from "./token.ts";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";

const audience = (users = pool.users) => ({ action: "audience" as const, pools: [{ ...pool, users }] });
const own = { pool: "personal-pool", organization: "personal-organization" };
const entry = async (f: ReturnType<typeof fixture>) => (await PoolDirectory.load(f.storage, f.now())).entry(pool.pool)!;

test("a successful removal retry renews refusal for bound pools and uncertain switch targets", async () => {
  for (const switching of [false, true]) {
    const f = fixture();
    const personal = { ...own, owner: member };
    await f.access(audience());
    const other = await f.create(member, personal);
    const computer = await f.create(member, switching ? personal : pool);
    if (switching) {
      f.server.patchReplyFailure = true;
      assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: pool.pool })).status, 503);
    }
    f.server.revokeFailure = true;
    assert.equal((await f.access(audience([owner]))).status, 503);
    f.advance(accessGrace + 1);
    f.restart();
    f.server.revokeFailure = false;
    assert.equal((await f.access(audience([owner]))).status, 200);
    assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
    f.advance(1);
    // The host read this audience before committing the retry, then stamped it afterward.
    assert.equal((await f.access(audience())).status, 200);
    assert.deepEqual((await entry(f)).users, [owner]);
    const fresh = await f.intent(member, personal);
    assert.equal((await f.action("switch", member, fresh, { id: other.computer.id, pool: pool.pool })).status, 403);
    assert.equal((await f.registry())[other.computer.id]!.state, "active");
  }
});

test("cancelled removal preserves a person's unfinished revoke", async () => {
  const f = fixture();
  const computer = await f.create();
  f.server.revokeFailure = true;
  assert.equal((await f.action("revoke", member, computer.intent, { id: computer.computer.id })).status, 503);
  assert.equal((await f.access(audience([owner]))).status, 503);
  f.restart();
  f.advance(1);
  assert.equal((await f.access(audience())).status, 200);
  const restored = (await f.registry())[computer.computer.id]!;
  assert.equal(restored.state, "revoking");
  assert.equal(restored.removalPending, undefined);
  assert.equal(restored.beforeRemoval, undefined);
  assert.equal(restored.link, undefined);
  assert.equal(f.server.keys.length, 1);
  f.server.revokeFailure = false;
  assert.equal((await f.action("revoke", member, computer.intent, { id: computer.computer.id })).status, 200);
  assert.equal(f.server.keys.length, 0);
});

test("cancelled removal keeps an unclaimed computer issuing and restores only a valid link", async () => {
  for (const delay of [1, setupTtl]) {
    const f = fixture();
    const computer = await f.create(member, pool, false);
    const original = (await f.registry())[computer.computer.id]!.link;
    f.server.revokeFailure = true;
    assert.equal((await f.access(audience([owner]))).status, 503);
    assert.equal((await f.registry())[computer.computer.id]!.link, undefined);
    assert.equal((await f.action("claim", member, undefined, { token: computer.token })).status, 410);
    // A repeated failed removal must keep the original state and link.
    assert.equal((await f.access(audience([owner]))).status, 503);
    f.restart();
    f.advance(delay);
    assert.equal((await f.access(audience())).status, 200);
    const restored = (await f.registry())[computer.computer.id]!;
    assert.equal(restored.state, "issuing");
    assert.equal(restored.removalPending, undefined);
    assert.equal(restored.beforeRemoval, undefined);
    assert.deepEqual(restored.link, delay < setupTtl ? original : undefined);
    assert.equal((await f.action("claim", member, undefined, { token: computer.token, format: "json" })).status,
      delay < setupTtl ? 200 : 410);
    if (delay === setupTtl) {
      f.server.revokeFailure = false;
      assert.equal((await f.action("revoke", member, await f.intent(), { id: computer.computer.id })).status, 200);
      assert.equal(f.server.keys.length, 0);
    }
  }
});

test("a newer audience cancels failed removal with the same Home key, including during grace", async () => {
  for (const delay of [1, 60_001]) {
    const f = fixture();
    const computer = await f.create();
    const keys = structuredClone(f.server.keys);
    f.server.revokeFailure = true;
    assert.equal((await f.access(audience([owner]))).status, 503);
    f.restart();
    f.advance(delay);
    const response = await f.access(audience());
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { revoked: 0, provisioned: 0 });
    assert.deepEqual(f.server.keys, keys);
    const restored = (await f.registry())[computer.computer.id]!;
    assert.equal(restored.state, "active");
    assert.equal(restored.removalPending, undefined);
    assert.equal((await f.context()).status, 200);
    assert.equal((await f.action("computers", member, computer.intent)).status, 200);
    f.advance(60_001);
    assert.equal((await f.access(audience())).status, 200);
    assert.deepEqual(f.server.keys, keys);
  }
});

test("a newer audience marks failed removal removed when Home already deleted the key", async () => {
  const f = fixture();
  const computer = await f.create();
  f.server.revokeFailure = true;
  assert.equal((await f.access(audience([owner]))).status, 503);
  f.server.keys = [];
  f.advance(1);
  const response = await f.access(audience());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: 0, provisioned: 0 });
  const removed = (await f.registry())[computer.computer.id]!;
  assert.equal(removed.state, "removed");
  assert.equal(removed.removalPending, undefined);
  assert.equal(removed.removedAt, new Date(f.now()).toISOString());
});

test("recovery requires newer audiences for every uncertain switch destination", async () => {
  const f = fixture();
  const computer = await f.create();
  const target = { ...pool, pool: "switch-target" };
  const next = { ...pool, pool: "next-target" };
  await f.access({ action: "audience", pools: [pool, target, next] });
  f.server.patchReplyFailure = true;
  for (const destination of [target, next])
    assert.equal((await f.action("switch", member, computer.intent, { id: computer.computer.id, pool: destination.pool })).status, 503);
  const keys = structuredClone(f.server.keys);
  f.server.revokeFailure = true;
  assert.equal((await f.access(audience([owner]))).status, 503);
  f.advance(1);
  for (const destination of [pool, target]) {
    assert.equal((await f.access({ action: "audience", pools: [destination] })).status, 200);
    assert.equal((await f.registry())[computer.computer.id]!.removalPending, true);
    assert.deepEqual(f.server.keys, keys);
  }
  assert.equal((await f.access({ action: "audience", pools: [next] })).status, 200);
  assert.equal((await f.registry())[computer.computer.id]!.state, "active");
  // The failed rebind's destination remains uncertain until an ordinary switch succeeds.
  assert.deepEqual((await f.registry())[computer.computer.id]!.switching, [target.pool, next.pool]);
  assert.deepEqual(f.server.keys, keys);
});

test("an audience from the removal attempt cannot cancel it", async () => {
  const f = fixture();
  const computer = await f.create();
  f.server.revokeFailure = true;
  assert.equal((await f.access(audience([owner]))).status, 503);
  assert.equal((await f.access(audience())).status, 503);
  assert.equal((await f.registry())[computer.computer.id]!.removalPending, true);
});

test("unfinished removal tells the person to ask the owner to retry", async () => {
  const f = fixture();
  await f.create();
  f.server.revokeFailure = true;
  assert.equal((await f.access(audience([owner]))).status, 503);
  f.advance(60_001);
  const response = await f.context();
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { message: string }).message,
    "Removing access from this computer didn't finish. Ask the owner to retry, or try again later.");
});

test("slow provisioning is bounded, revocation succeeds and the alarm can finish pending users", async (t) => {
  const f = fixture();
  const computer = await f.create();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const slow = t.mock.method(f.home, "user", async () => { started(); await gate; return 999; });
  const failSafe = setTimeout(() => release(), 4_000);
  t.after(() => { clearTimeout(failSafe); release(); });
  const startedAt = performance.now();
  const responsePromise = f.access(audience([owner, "new-member", "another-member"]));
  await entered;
  const response = await responsePromise;
  const elapsed = performance.now() - startedAt;
  assert.equal(response.status, 200);
  assert.ok(elapsed < 3_500, `Access took ${elapsed} ms`);
  assert.deepEqual(await response.json(), { revoked: 1, provisioned: 0 });
  assert.equal((await f.registry())[computer.computer.id]!.state, "removed");
  assert.equal(f.server.keys.length, 0);
  assert.deepEqual((await entry(f)).pending, ["new-member", "another-member"]);
  release();
  slow.mock.restore();
  f.restart();
  await f.expire();
  assert.deepEqual((await entry(f)).pending, []);
  assert.equal(f.server.users.length, 3);
});

test("the provisioning budget applies to the whole audience rather than each user", async (t) => {
  const f = fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const provision = f.home.user.bind(f.home);
  const slow = t.mock.method(f.home, "user", async (user: string, pool: string, created?: () => void, signal?: AbortSignal) => {
    t.mock.timers.tick(750);
    signal?.throwIfAborted();
    return provision(user, pool, created, signal);
  });
  const users = ["new-1", "new-2", "new-3", "new-4"];
  const response = await f.access(audience([owner, ...users]));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: 0, provisioned: 2 });
  assert.deepEqual((await entry(f)).pending, users.slice(2));
  slow.mock.restore();
  await f.expire();
  assert.deepEqual((await entry(f)).pending, []);
  assert.equal(f.server.users.length, 4);
});

test("signed own metadata learns a personal pool for computers, switch, links and validate", async () => {
  for (const action of ["computers", "switch", "links", "validate"]) {
    const f = fixture();
    const computer = await f.create();
    const extra = action === "switch" ? { id: computer.computer.id, pool: own.pool }
      : { name: "Second", toolsKeyId: "second", toolsToken: "fake-second" };
    const response = await f.action(action, member, computer.intent, { ...extra, own });
    assert.equal(response.status, 200, await response.clone().text());
    const listing = await f.action("computers", member, computer.intent);
    const value = await listing.json() as { pools: { id: string; mine: boolean }[] };
    assert.ok(value.pools.some((choice) => choice.id === own.pool && choice.mine));
    const personal = (await PoolDirectory.load(f.storage, f.now())).entry(own.pool)!;
    assert.equal(personal.owner, member);
    assert.equal(personal.organization, own.organization);
  }
});

test("own metadata is ignored when refused, deleted or malformed", async () => {
  for (const kind of ["refused", "deleted", "malformed"]) {
    const f = fixture();
    const intent = await f.intent();
    const personal = { ...own, owner, name: "Personal", users: [owner, member] };
    if (kind === "refused") {
      await f.access({ action: "audience", pools: [personal] });
      await f.access({ action: "audience", pools: [{ ...personal, users: [owner] }] });
    }
    if (kind === "deleted") await f.access({ action: "pool-deleted", pool: own.pool });
    const response = await f.action("computers", member, intent, { own: kind === "malformed" ? { ...own, organization: " " } : own });
    assert.equal(response.status, 200);
    const value = await response.json() as { pools: { id: string }[] };
    assert.ok(!value.pools.some((choice) => choice.id === own.pool), kind);
    const personalEntry = (await PoolDirectory.load(f.storage, f.now())).entry(own.pool);
    assert.notEqual(personalEntry?.owner, member, kind);
  }
});

test("own outside the setup host's signed envelope is ignored", async () => {
  const f = fixture();
  const intent = await f.intent();
  const computers = new Computers({ storage: f.storage, home: f.home, signingKey, now: f.now });
  const envelope = await signEnvelope(signingKey, "sbs1", { action: "computers", user: member, intent, expiresAt: f.now() + 10_000 });
  const response = await computers.handle(new Request("https://pool.example/__setup/v1/computers", {
    method: "POST", body: JSON.stringify({ envelope, own }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await PoolDirectory.load(f.storage, f.now())).entry(own.pool), undefined);
});
