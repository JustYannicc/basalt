import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import {
  nativeControlPath,
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
} from "./native-contract.ts";
import { signEnvelope } from "./token.ts";

function protocol() {
  const f = fixture();
  const grant = "native:protocol-client";
  const control = async (action: string, values: Record<string, unknown> = {}) => {
    const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
      action,
      user: owner,
      grant,
      models: true,
      expiresAt: f.now() + 10_000,
      ...values,
    });
    return f.nativeControl(
      new Request(`https://pool.example${nativeControlPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
    );
  };
  const register = async (nextGrant = grant) => {
    const result = await control("register", {
      grant: nextGrant,
      intent: await f.intent(owner),
      name: "Native client",
      tools: true,
    });
    assert.equal(result.status, 200, await result.clone().text());
    return (await result.json()) as {
      computer: { id: string };
      pool: string;
      toolsOrganization: string;
    };
  };
  const model = async (
    computer: string,
    values: Record<string, unknown> = {},
    path = "/v1/responses",
  ) => {
    const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
      user: owner,
      grant,
      computer,
      pool: pool.pool,
      expiresAt: f.now() + 10_000,
      method: "POST",
      path,
      ...values,
    });
    return f.nativeModel(
      new Request(`https://pool.example${path}`, {
        method: "POST",
        headers: {
          [nativeModelHeader]: assertion,
          authorization: "Bearer original-oauth",
          cookie: "unrelated=secret",
        },
        body: JSON.stringify({ model: "protocol-model", stream: true }),
      }),
    );
  };
  return { f, grant, control, register, model };
}

test("native registration retains the model key on the server and survives restart", async () => {
  const p = protocol();
  const registered = await p.register();
  assert.equal(registered.toolsOrganization, pool.organization);
  const computer = (await p.f.registry())[registered.computer.id]!;
  const homeKey = String(p.f.server.keys[0]!.api_key);
  assert.equal(JSON.stringify(registered).includes(homeKey), false);
  assert.equal(JSON.stringify(computer).includes(homeKey), false);
  assert.ok(computer.native?.key);
  p.f.restart();
  const lease = await p.model(computer.id);
  assert.equal(lease.request.headers.get("authorization"), `Bearer ${homeKey}`);
  assert.equal(lease.request.headers.has(nativeModelHeader), false);
  assert.equal(lease.request.headers.has("cookie"), false);
  assert.equal(lease.signal.aborted, false);
  lease.release();
  await assert.rejects(p.model(computer.id, { user: member }), /no longer connected/);
  await assert.rejects(p.model(computer.id, { pool: "foreign-pool" }), /no longer connected/);
  await assert.rejects(
    p.model(computer.id, { grant: "native:another-device" }),
    /no longer connected/,
  );
  await assert.rejects(p.model(computer.id, { method: "GET" }), /another request/);
});

test("native revocation aborts active model access before failed backend cleanup", async () => {
  const p = protocol();
  const registered = await p.register();
  const id = registered.computer.id;
  const lease = await p.model(id);
  let closed = false;
  lease.onClose(() => {
    closed = true;
  });
  p.f.server.revokeFailure = true;
  p.f.server.onRevoke = () => {
    assert.equal(lease.signal.aborted, true);
    assert.equal(closed, true);
  };
  assert.equal((await p.control("revoke", { computer: id, pool: pool.pool })).status, 503);
  assert.equal(lease.signal.aborted, true, "Persisted refusal must abort the active model request");
  assert.equal(closed, true, "Persisted refusal must close the native response");
  p.f.restart();
  assert.equal((await p.control("check", { computer: id, pool: pool.pool })).status, 401);
  await assert.rejects(p.model(id), /no longer connected/);
  p.f.server.revokeFailure = false;
  assert.equal((await p.control("revoke", { computer: id, pool: pool.pool })).status, 200);
  assert.equal(p.f.server.keys.length, 0);
  assert.equal((await p.f.registry())[id]?.state, "revoked");
});

test("existing computer revocation and membership removal stop native streams", async () => {
  const p = protocol();
  const registered = await p.register();
  const id = registered.computer.id;
  const lease = await p.model(id);
  const intent = await p.f.intent(owner);
  assert.equal((await p.f.action("revoke", owner, intent, { id })).status, 200);
  assert.equal(lease.signal.aborted, true);
  assert.equal(
    (
      await p.control("register", {
        intent,
        name: "Revoked grant replay",
        tools: true,
      })
    ).status,
    401,
  );
  const nextGrant = "native:another-device";
  const next = await p.register(nextGrant);
  const nextLease = await p.model(next.computer.id, { grant: nextGrant });
  assert.equal(
    (
      await p.f.access({
        action: "audience",
        pools: [{ ...pool, users: [member], authorization: "executor-app-v1", managers: [owner] }],
      })
    ).status,
    200,
  );
  assert.equal(nextLease.signal.aborted, true);
  assert.equal(
    (await p.control("check", { grant: nextGrant, computer: next.computer.id, pool: pool.pool }))
      .status,
    401,
  );
});

test("native registration refuses expired or foreign intents and unselected pools", async () => {
  const p = protocol();
  const ownIntent = await p.f.intent(owner);
  const common = { intent: ownIntent, name: "Native client", tools: true };
  assert.equal((await p.control("register", { ...common, pool: "foreign-pool" })).status, 403);
  assert.equal((await p.control("register", { ...common, user: member })).status, 401);
  p.f.advance(300_001);
  assert.equal((await p.control("register", common)).status, 401);
  assert.equal(p.f.server.keys.length, 0);
});

test("native approval refuses a signed intent whose organization conflicts with its pool", async () => {
  const p = protocol();
  const ownIntent = await p.f.intent(owner);
  const mismatched = await p.f.intent(owner, { ...pool, organization: "foreign-organization" });
  assert.equal(
    (
      await p.control("register", {
        intent: mismatched,
        name: "Substituted organization",
        tools: true,
      })
    ).status,
    403,
  );
  assert.equal(p.f.server.keys.length, 0);
  const [prefix, payload, signature] = ownIntent.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<
    string,
    unknown
  >;
  const altered = Buffer.from(
    JSON.stringify({ ...claims, organization: "foreign-organization" }),
  ).toString("base64url");
  assert.equal(
    (
      await p.control("register", {
        intent: `${prefix}.${altered}.${signature}`,
        name: "Tampered organization",
        tools: true,
      })
    ).status,
    401,
  );
  assert.equal(p.f.server.keys.length, 0);
});

test("replayed native registration keeps one computer and cannot substitute its pool or tools organization", async () => {
  const p = protocol();
  const intent = await p.f.intent(owner);
  const values = { intent, name: "Approved device", tools: true };
  const first = await p.control("register", values);
  assert.equal(first.status, 200);
  const original = (await first.json()) as { computer: { id: string }; toolsOrganization: string };
  const replayed = await p.control("register", values);
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), original);
  assert.equal(p.f.server.keys.length, 1);
  assert.equal(Object.keys(await p.f.registry()).length, 1);
  const foreign = { ...pool, pool: "another-owned-pool", organization: "another-organization" };
  const foreignIntent = await p.f.intent(owner, foreign);
  assert.equal(
    (
      await p.control("register", {
        ...values,
        intent: foreignIntent,
        pool: foreign.pool,
      })
    ).status,
    403,
  );
  assert.equal(p.f.server.keys.length, 1);
  assert.equal(
    (await p.f.registry())[original.computer.id]?.native?.toolsOrganization,
    pool.organization,
  );
});

test("native tools stay on the user's own intent while models may use a shared pool", async () => {
  const p = protocol();
  const shared = {
    ...pool,
    pool: "shared-pool",
    owner: member,
    organization: "shared-organization",
  };
  await p.f.access({ action: "audience", pools: [shared] });
  const ownIntent = await p.f.intent(owner);
  const response = await p.control("register", {
    intent: ownIntent,
    name: "Shared models",
    tools: true,
    pool: shared.pool,
    organization: shared.organization,
    toolsOrganization: shared.organization,
  });
  assert.equal(response.status, 200);
  const approved = (await response.json()) as {
    computer: { id: string };
    pool: string;
    toolsOrganization: string;
  };
  assert.equal(approved.pool, shared.pool);
  assert.equal(approved.toolsOrganization, pool.organization);
  assert.equal(
    (await p.f.registry())[approved.computer.id]?.native?.toolsOrganization,
    pool.organization,
  );
  const memberIntent = await p.f.intent(member);
  assert.equal(
    (
      await p.control("register", {
        user: member,
        grant: "native:shared-intent",
        intent: memberIntent,
        name: "Wrong tools source",
        tools: true,
      })
    ).status,
    403,
  );
  assert.equal(p.f.server.keys.length, 1);
});

test("tools-only native approval mints no model key and cannot widen on replay", async () => {
  const p = protocol();
  const intent = await p.f.intent(owner);
  const response = await p.control("register", {
    intent,
    name: "Tools only",
    tools: true,
    models: false,
  });
  assert.equal(response.status, 200);
  const approved = (await response.json()) as {
    computer: { id: string };
    models: boolean;
    toolsOrganization: string;
  };
  assert.equal(approved.models, false);
  assert.equal(approved.toolsOrganization, pool.organization);
  assert.equal(p.f.server.keys.length, 0);
  assert.equal(
    (await p.control("check", { computer: approved.computer.id, pool: pool.pool })).status,
    200,
  );
  await assert.rejects(p.model(approved.computer.id), /tools only/);
  assert.equal(
    (await p.control("register", { intent, name: "Widened", tools: true, models: true })).status,
    403,
  );
  assert.equal(
    (await p.control("revoke", { computer: approved.computer.id, pool: pool.pool })).status,
    200,
  );
  assert.equal(
    (await p.control("check", { computer: approved.computer.id, pool: pool.pool })).status,
    401,
  );
});
