import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import { nativeControlPath, nativeControlPrefix } from "./native-contract.ts";
import { signEnvelope } from "./token.ts";

function displayProtocol() {
  const f = fixture(),
    grant = "native:display-client";
  const control = async (action: string, values: Record<string, unknown> = {}) => {
    const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
      action,
      user: owner,
      grant,
      expiresAt: f.now() + 10000,
      ...values,
    });
    return f.nativeControl(
      new Request(`https://pool.example${nativeControlPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
    );
  };
  const register = async (models = true) => {
    const response = await control("register", {
      intent: await f.intent(owner),
      name: "Display client",
      tools: true,
      models,
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { computer: { id: string } };
  };
  return { f, control, register };
}

test("native display lists current usable pool names without changing authority or storage", async () => {
  const p = displayProtocol();
  const shared = { ...pool, pool: "shared", name: "Shared pool", owner: member };
  const hidden = { ...pool, pool: "hidden", name: "Private pool", owner: member, users: [member] };
  const managed = {
    ...pool,
    pool: "managed",
    name: "Managed only",
    users: [member],
    authorization: "executor-app-v1" as const,
    managers: [owner],
  };
  assert.equal(
    (await p.f.access({ action: "audience", pools: [pool, shared, hidden, managed] })).status,
    200,
  );
  const { computer } = await p.register();
  const identity = { computer: computer.id, pool: pool.pool };
  const before = structuredClone([...p.f.storage.values]);
  const response = await p.control("check", { ...identity, display: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    active: true,
    display: {
      pool: { id: pool.pool, name: pool.name },
      pools: [
        { id: pool.pool, name: pool.name },
        { id: shared.pool, name: shared.name },
      ],
    },
  });
  assert.deepEqual([...p.f.storage.values], before);
  const ordinary = await p.control("check", identity);
  assert.deepEqual(await ordinary.json(), { active: true });
  assert.equal(
    (await p.f.access({ action: "audience", pools: [{ ...shared, users: [member] }] })).status,
    200,
  );
  const changed = await p.control("check", { ...identity, display: true });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), {
    active: true,
    display: {
      pool: { id: pool.pool, name: pool.name },
      pools: [{ id: pool.pool, name: pool.name }],
    },
  });
  for (const wrong of [
    { user: member },
    { grant: "native:other" },
    { pool: shared.pool },
    { expiresAt: p.f.now() - 1 },
  ]) {
    assert.equal((await p.control("check", { ...identity, display: true, ...wrong })).status, 401);
  }
  assert.equal((await p.control("revoke", identity)).status, 200);
  assert.equal((await p.control("check", { ...identity, display: true })).status, 401);
});

test("tools-only native display names its bound pool without listing model choices", async () => {
  const p = displayProtocol();
  assert.equal((await p.f.access({ action: "audience", pools: [pool] })).status, 200);
  const { computer } = await p.register(false);
  const response = await p.control("check", {
    computer: computer.id,
    pool: pool.pool,
    display: true,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    active: true,
    display: { pool: { id: pool.pool, name: pool.name }, pools: [] },
  });
});

test("legacy pools without names use the existing personal and shared labels", async () => {
  const p = displayProtocol();
  const shared = { ...pool, pool: "legacy-shared", name: "", owner: member };
  assert.equal(
    (await p.f.access({ action: "audience", pools: [{ ...pool, name: "   " }, shared] })).status,
    200,
  );
  const { computer } = await p.register();
  const before = structuredClone([...p.f.storage.values]);
  const response = await p.control("check", {
    computer: computer.id,
    pool: pool.pool,
    display: true,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    active: true,
    display: {
      pool: { id: pool.pool, name: "Your pool" },
      pools: [
        { id: pool.pool, name: "Your pool" },
        { id: shared.pool, name: "Shared pool" },
      ],
    },
  });
  assert.deepEqual([...p.f.storage.values], before);
});
