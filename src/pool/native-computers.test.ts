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
import { modelDrainProtocol } from "./model-drain-contract.ts";

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
  assert.equal(p.f.server.keys.length, 0, "Approval mints nothing; the first model use does");
  (await p.model(registered.computer.id)).release();
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

test("only a signed native v2 choice selects the internal model drain protocol", async () => {
  const p = protocol();
  const registered = await p.register();
  for (const selected of [false, true]) {
    const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
      user: owner,
      grant: p.grant,
      computer: registered.computer.id,
      pool: pool.pool,
      method: "GET",
      path: "/v1/responses",
      expiresAt: p.f.now() + 10_000,
      ...(selected ? { modelDrain: modelDrainProtocol } : {}),
    });
    const lease = await p.f.nativeModel(
      new Request("https://pool.example/v1/responses", {
        headers: {
          [nativeModelHeader]: assertion,
          "sec-websocket-protocol": modelDrainProtocol,
          upgrade: "websocket",
        },
      }),
    );
    assert.equal(
      lease.request.headers.get("sec-websocket-protocol"),
      selected ? modelDrainProtocol : null,
    );
    lease.release();
  }
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
  // A device its person revoked answers 410, so the host can end its grant.
  assert.equal((await p.control("check", { computer: id, pool: pool.pool })).status, 410);
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
  (await p.model(original.computer.id)).release();
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
  (await p.model(approved.computer.id, { pool: shared.pool })).release();
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
    410,
  );
});

test("native approval with models answers at once while the pool container is stopped", async () => {
  const p = protocol();
  const intent = await p.f.intent(owner);
  p.f.server.stopped = true;
  const response = await p.control("register", { intent, name: "Stopped container", tools: true });
  assert.deepEqual(
    Object.values(await p.f.registry()).map((computer) => computer.state),
    ["active"],
    "A stopped container must leave no issuing computer behind",
  );
  assert.equal(response.status, 200, await response.clone().text());
  const approved = (await response.json()) as {
    pool: string;
    models: boolean;
    toolsOrganization: string;
  };
  assert.equal(approved.pool, pool.pool);
  assert.equal(approved.models, true);
  assert.equal(approved.toolsOrganization, pool.organization);
  assert.equal(p.f.server.keys.length, 0);
});

test("a model request arriving during a mint shares it instead of minting again", async () => {
  const p = protocol();
  const intent = await p.f.intent(owner);
  const { computer } = await p.register();
  let reached!: () => void;
  const minting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let open!: () => void;
  p.f.server.onMint = reached;
  p.f.server.mintGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const first = p.model(computer.id);
  await minting;
  let reading!: () => void;
  const read = new Promise<void>((resolve) => {
    reading = resolve;
  });
  p.f.storage.onGet = (key) => {
    if (key === "computer-registry-v1") reading();
  };
  const second = p.model(computer.id);
  await read;
  p.f.storage.onGet = undefined;
  // Queued behind the second request's registry read: it has joined the mint or started its own.
  assert.equal((await p.f.action("computers", owner, intent)).status, 200);
  open();
  const leases = await Promise.all([first, second]);
  const mints = p.f.server.calls.filter(
    (call) => call.path === "/access/api-keys" && call.method === "POST",
  );
  assert.equal(mints.length, 1, "Concurrent first model requests must mint once");
  for (const lease of leases) {
    assert.equal(
      lease.request.headers.get("authorization"),
      `Bearer ${String(p.f.server.keys[0]!.api_key)}`,
    );
    lease.release();
  }
});

test("a device revoked while its model key is minted keeps no key", async () => {
  const p = protocol();
  const { computer } = await p.register();
  let reached!: () => void;
  const minting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let open!: () => void;
  p.f.server.onMint = reached;
  p.f.server.mintGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const request = p.model(computer.id);
  await Promise.race([
    minting,
    request.then(
      () => {},
      () => {},
    ),
  ]);
  assert.equal((await p.control("revoke", { computer: computer.id, pool: pool.pool })).status, 200);
  open();
  await assert.rejects(request, /no longer connected/);
  assert.equal(p.f.server.keys.length, 0);
  assert.equal((await p.f.registry())[computer.id]?.native?.key, undefined);
});

test("a restored audience keeps a model device that was approved before its key existed", async () => {
  const p = protocol();
  const audience = (users: string[]) => ({
    action: "audience" as const,
    pools: [{ ...pool, users }],
  });
  assert.equal((await p.f.access(audience(pool.users))).status, 200);
  const intent = await p.f.intent(member);
  const device = { user: member, grant: "native:member-models" };
  p.f.server.stopped = true;
  const response = await p.control("register", {
    ...device,
    intent,
    name: "Member models",
    tools: false,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { computer } = (await response.json()) as { computer: { id: string } };
  const identity = { ...device, computer: computer.id, pool: pool.pool };
  // The removal cannot reach Home while the container is stopped, so it stays pending.
  assert.equal((await p.f.access(audience([owner]))).status, 503);
  assert.equal((await p.f.registry())[computer.id]?.removalPending, true);
  p.f.advance(1);
  assert.equal((await p.f.access(audience(pool.users))).status, 200);
  assert.equal((await p.f.registry())[computer.id]?.state, "active");
  assert.equal((await p.control("check", identity)).status, 200);
  p.f.server.stopped = false;
  (await p.model(computer.id, device)).release();
  assert.equal(p.f.server.keys.length, 1);
});

test("a device with no model key revokes while Home is stopped and leaves no revoking row", async () => {
  const p = protocol();
  const intent = await p.f.intent(owner);
  p.f.server.stopped = true;
  const devices = [
    { grant: "native:tools-only", tools: true, models: false },
    { grant: "native:models-pending", tools: false, models: true },
  ];
  for (const device of devices) {
    const response = await p.control("register", { ...device, intent, name: device.grant });
    assert.equal(response.status, 200, await response.clone().text());
    const { computer } = (await response.json()) as { computer: { id: string } };
    const identity = { grant: device.grant, computer: computer.id, pool: pool.pool };
    const revoked = await p.control("revoke", identity);
    assert.equal(revoked.status, 200, `${device.grant}: ${await revoked.clone().text()}`);
    assert.equal((await p.f.registry())[computer.id]?.state, "revoked", device.grant);
    assert.equal((await p.control("check", identity)).status, 410, device.grant);
  }
});

/** A member's models-only device whose key is minted: access removal can take it from them. */
async function memberDevice(p: ReturnType<typeof protocol>) {
  const as = { user: member, grant: "native:member-device" };
  const registered = await p.control("register", {
    ...as,
    intent: await p.f.intent(member),
    name: "Member device",
    tools: false,
    models: true,
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  const { computer } = (await registered.json()) as { computer: { id: string } };
  (await p.model(computer.id, as)).release();
  const identity = { ...as, computer: computer.id, pool: pool.pool };
  return { id: computer.id, check: () => p.control("check", identity), identity };
}
const audience = (users: string[]) => ({
  action: "audience" as const,
  pools: [{ ...pool, users }],
});

test("a device its person revoked answers 410 after access removal finishes it as removed", async () => {
  const p = protocol();
  const device = await memberDevice(p);
  p.f.server.revokeFailure = true;
  assert.equal((await p.control("revoke", device.identity)).status, 503);
  p.f.server.revokeFailure = false;
  assert.equal((await p.f.access(audience([owner]))).status, 200);
  assert.equal((await p.f.registry())[device.id]?.state, "removed");
  assert.equal((await device.check()).status, 410);
});

test("a device removed for lost access, not revoked, still answers 401", async () => {
  const p = protocol();
  const device = await memberDevice(p);
  assert.equal((await p.f.access(audience([owner]))).status, 200);
  assert.equal((await p.f.registry())[device.id]?.state, "removed");
  assert.equal((await device.check()).status, 401);
});

test("a row removed before the pool recorded why answers 410: every native check refused it", async () => {
  const p = protocol();
  const device = await memberDevice(p);
  const registry = await p.f.registry();
  registry[device.id]!.state = "removed";
  await p.f.storage.put("computer-registry-v1", registry);
  assert.equal((await device.check()).status, 410);
});

test("a row access is restored to without its earlier state is never reported revoked", async () => {
  const p = protocol();
  const device = await memberDevice(p);
  // Removal can't finish while Home fails, so the row waits with removal pending.
  p.f.server.revokeFailure = true;
  assert.equal((await p.f.access(audience([owner]))).status, 503);
  // As an older release left it: no record of its state before removal.
  const registry = await p.f.registry();
  assert.equal(registry[device.id]?.removalPending, true);
  delete registry[device.id]!.beforeRemoval;
  await p.f.storage.put("computer-registry-v1", registry);
  p.f.server.revokeFailure = false;
  p.f.advance(1);
  assert.equal((await p.f.access(audience([owner, member]))).status, 200);
  const restored = (await p.f.registry())[device.id];
  assert.equal(restored?.state, "revoking");
  assert.equal(restored?.removalPending, undefined);
  assert.equal((await device.check()).status, 401, "its person may never have revoked it");
  await p.f.expire();
  assert.equal((await p.f.registry())[device.id]?.state, "revoking", "upkeep leaves it too");
});

test("a device holding a model key still revokes it through Home", async () => {
  const p = protocol();
  const { computer } = await p.register();
  (await p.model(computer.id)).release();
  assert.equal(p.f.server.keys.length, 1);
  p.f.server.stopped = true;
  const identity = { computer: computer.id, pool: pool.pool };
  assert.equal((await p.control("revoke", identity)).status, 503);
  assert.equal((await p.f.registry())[computer.id]?.state, "revoking");
  p.f.server.stopped = false;
  assert.equal((await p.control("revoke", identity)).status, 200);
  assert.equal(p.f.server.keys.length, 0);
  assert.equal((await p.f.registry())[computer.id]?.state, "revoked");
});

test("a revoke the host repeats for a revoked device answers at once while Home is stopped", async () => {
  const p = protocol();
  const { computer } = await p.register();
  (await p.model(computer.id)).release();
  const identity = { computer: computer.id, pool: pool.pool };
  assert.equal((await p.control("revoke", identity)).status, 200);
  assert.equal(p.f.server.keys.length, 0);
  p.f.server.stopped = true;
  const again = await p.control("revoke", identity);
  assert.equal(again.status, 200, await again.clone().text());
  assert.deepEqual(await again.json(), { revoked: true });
  assert.equal((await p.f.registry())[computer.id]?.state, "revoked");
});

test("Connect's revoke of a keyless native device names its grant and needs no Home", async () => {
  const p = protocol();
  const intent = await p.f.intent(owner);
  const response = await p.control("register", {
    grant: "native:tools-only",
    intent,
    name: "Tools only",
    tools: true,
    models: false,
  });
  const { computer } = (await response.json()) as { computer: { id: string } };
  p.f.server.stopped = true;
  const revoked = await p.f.action("revoke", owner, intent, { id: computer.id });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  // Its tools answer to that grant at the tools service, so the setup host revokes it next.
  assert.deepEqual(await revoked.json(), { toolsKeyId: null, grant: "native:tools-only" });
  assert.equal((await p.f.action("revoked", owner, intent, { id: computer.id })).status, 200);
  assert.equal((await p.f.registry())[computer.id]?.state, "revoked");
});

test("revoking a model device after a lost mint reply removes the key Home kept", async () => {
  const p = protocol();
  const { computer } = await p.register();
  p.f.server.mintReplyFailure = true;
  await assert.rejects(p.model(computer.id), /unavailable/);
  p.f.server.mintReplyFailure = false;
  assert.equal(p.f.server.keys.length, 1, "Home made a key whose reply was lost");
  assert.equal((await p.f.registry())[computer.id]?.keyId, undefined);
  assert.equal((await p.control("revoke", { computer: computer.id, pool: pool.pool })).status, 200);
  assert.equal(p.f.server.keys.length, 0);
});

test("the tools service's report of a tools-only device lists it once and never revives it", async () => {
  const p = protocol();
  const device = {
    grant: "native:tools-only-learned",
    computer: "a".repeat(32),
    pool: pool.pool,
    toolsOrganization: pool.organization,
    name: "Work laptop",
  };
  const learn = (values: Record<string, unknown>) => p.control("learn", { ...device, ...values });
  assert.equal((await learn({})).status, 200);
  const listed = (await p.f.registry())[device.computer];
  assert.equal(listed?.name, "Work laptop");
  assert.equal(listed?.state, "active");
  assert.deepEqual(listed?.native, {
    grant: device.grant,
    models: false,
    toolsOrganization: pool.organization,
  });
  // A repeat, or another grant claiming the same id, changes nothing.
  assert.equal((await learn({ name: "Renamed" })).status, 200);
  assert.equal((await learn({ grant: "native:someone-else" })).status, 200);
  assert.equal((await p.f.registry())[device.computer]?.name, "Work laptop");
  assert.equal(Object.keys(await p.f.registry()).length, 1);
  // Once revoked, the device stays revoked whatever the tools service reports later.
  assert.equal((await p.control("revoke", device)).status, 200);
  assert.equal((await learn({})).status, 200);
  assert.equal((await p.f.registry())[device.computer]?.state, "revoked");
});

test("a tools-only device revoked before its approval's report arrives stays revoked", async () => {
  const p = protocol();
  const device = {
    grant: "native:revoked-first",
    computer: "b".repeat(32),
    pool: pool.pool,
    toolsOrganization: pool.organization,
  };
  // A models device the pool doesn't know is still unknown; a tools-only one is recorded revoked.
  assert.equal((await p.control("revoke", { ...device, grant: "native:models" })).status, 404);
  assert.equal((await p.control("revoke", { ...device, models: false })).status, 200);
  assert.equal((await p.control("learn", { ...device, name: "Late report" })).status, 200);
  const row = (await p.f.registry())[device.computer];
  assert.equal(row?.state, "revoked");
  assert.ok(row?.revokedAt);
});

test("Connect's report of a revoked grant revokes its tools-only row and adds no revoked device", async () => {
  const p = protocol();
  const live = {
    grant: "native:signed-out-elsewhere",
    computer: "c".repeat(32),
    pool: pool.pool,
    toolsOrganization: pool.organization,
  };
  const intent = await p.f.intent(owner);
  const list = async (native: Record<string, unknown>[]) => {
    const response = await p.f.action("computers", owner, intent, { native });
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { computers: { id: string; state: string }[] }).computers;
  };
  assert.deepEqual(
    (await list([live])).map(({ id, state }) => [id, state]),
    [[live.computer, "active"]],
  );
  const never = { ...live, grant: "native:never-listed", computer: "d".repeat(32), revoked: true };
  const listed = await list([{ ...live, revoked: true }, never]);
  assert.deepEqual(
    listed.map(({ id, state }) => [id, state]),
    [[live.computer, "revoked"]],
  );
});
