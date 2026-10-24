import assert from "node:assert/strict";
import { test } from "node:test";
import { callerHeader } from "../../apps/pool/contract.ts";
import { ComputerHome } from "./computer-home.ts";
import { Computers, type ComputerStorage } from "./computers.ts";
import { digest } from "./computer-home.ts";
import { setupTtl, signIntent } from "./setup-links.ts";
import { signEnvelope, signPoolToken } from "./token.ts";
import { HomeClient } from "./control.ts";

const signingKey = "ab".repeat(32);
const owner = "tools-user-1";
const claims = { pool: "pool-a", owner, organization: "org-a" };
const toolsKeyId = "tools-key-a";
const toolsToken = "tools-secret-a";
const modelKey = "model-secret-a";
const modelObservedAt = "2026-01-01T00:01:00.000Z";

class DurableMemory implements ComputerStorage {
  private values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async snapshot<T>(key: string): Promise<T | undefined> { return this.get<T>(key); }
  async serialized(): Promise<string> { return JSON.stringify([...this.values]); }
}

class FakeComputerHome extends ComputerHome {
  mints: { person: string; pool: string; computer: string }[] = [];
  revoked: number[] = [];
  found: string[] = [];
  rebound: { keyId: number; pool: string }[] = [];
  observations: { pool: string; keyId: number; since: string }[] = [];
  orphanKeyIds: number[] = [];
  mintFailure: Error | undefined;
  revokeGate: Promise<void> | undefined;
  onRevoke: (() => void) | undefined;

  constructor() {
    super(new HomeClient(async () => { throw new Error("unexpected real Home request"); }));
  }
  override async mint(person: string, pool: string, computer: string) {
    this.mints.push({ person, pool, computer });
    if (this.mintFailure) throw this.mintFailure;
    return { key: modelKey, keyId: 73, userId: 19 };
  }
  override async find(computer: string): Promise<number[]> {
    this.found.push(computer);
    return [...this.orphanKeyIds];
  }
  override async revoke(keyId: number): Promise<void> {
    this.revoked.push(keyId);
    this.onRevoke?.();
    await this.revokeGate;
  }
  override async rebind(keyId: number, pool: string): Promise<void> {
    this.rebound.push({ keyId, pool });
  }
  override async observed(pool: string, keyId: number, since: string): Promise<string | null> {
    this.observations.push({ pool, keyId, since });
    return modelObservedAt;
  }
}

async function fixture() {
  const storage = new DurableMemory();
  const home = new FakeComputerHome();
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const computers = new Computers({ storage, home, signingKey, origin: "https://setup.example", now: () => time });

  async function context(poolClaims = claims, caller = poolClaims.owner) {
    const token = await signPoolToken(signingKey, poolClaims);
    const response = await computers.context(new Request("https://pool.example/pool/v1/computers/context", {
      headers: { Authorization: `Bearer ${token}`, [callerHeader]: caller },
    }));
    return { response, value: await response.clone().json() as Record<string, unknown> };
  }
  async function action(actionName: string, user = owner, intent?: string, extra: Record<string, unknown> = {}) {
    const envelope = await signEnvelope(signingKey, "sbs1", {
      ...extra, action: actionName, expiresAt: time + 10_000, user, ...(intent ? { intent } : {}),
    });
    return computers.handle(new Request(`https://pool.example/setup/${actionName}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envelope }),
    }));
  }
  async function create(poolClaims = claims, user = owner) {
    const setup = await context(poolClaims, user);
    assert.equal(setup.response.status, 200, JSON.stringify(setup.value));
    const intent = String(setup.value.intent);
    const response = await action("links", user, intent, { name: "Workstation", toolsKeyId, toolsToken });
    assert.equal(response.status, 200, await response.clone().text());
    return { intent, value: await response.json() as { computer: { id: string; state: string; createdAt: string }; token: string; expiresAt: string } };
  }
  return {
    storage, home, computers, context, action, create,
    advance(ms: number) { time += ms; },
    now() { return time; },
  };
}

async function expectError(response: Response, status: number, code: string, message?: string) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json() as { error: string; message: string };
  assert.equal(body.error, code);
  if (message) assert.equal(body.message, message);
}

async function claim(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  return f.action("claim", owner, undefined, { token, format: "json" });
}

test("pool context signs caller and pool into a setup intent used by the internal mint envelope", async () => {
  const f = await fixture();
  const setup = await f.context();
  assert.equal(setup.response.status, 200, JSON.stringify(setup.value));
  const intent = String(setup.value.intent);
  const payload = JSON.parse(Buffer.from(intent.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
  assert.equal(payload.user, owner);
  assert.equal(payload.pool, claims.pool);
  assert.equal(payload.owner, claims.owner);

  const response = await f.action("links", owner, intent, { name: "Workstation", toolsKeyId, toolsToken });
  assert.equal(response.status, 200, await response.clone().text());
  const issued = await response.json() as { computer: { id: string; state: string }; token: string };
  assert.equal(issued.computer.state, "issuing");
  assert.ok(issued.token);
  assert.deepEqual(f.home.mints, [{ person: owner, pool: claims.pool, computer: issued.computer.id }]);
});

test("invalid pool tokens stop before Home mint", async () => {
  const f = await fixture();
  const badToken = await f.computers.context(new Request("https://pool.example/pool/v1/computers/context", {
    headers: { Authorization: "Bearer invalid", [callerHeader]: owner },
  }));
  await expectError(badToken, 401, "unauthorized");
  assert.equal(f.home.mints.length, 0);
});

test("a signed intent cannot be used by another caller or after tampering", async () => {
  const f = await fixture();
  const setup = await f.context();
  const intent = String(setup.value.intent);
  await expectError(await f.action("links", "tools-user-2", intent, { name: "Workstation", toolsKeyId, toolsToken }), 401, "unauthorized");
  await expectError(await f.action("links", owner, `${intent}x`, { name: "Workstation", toolsKeyId, toolsToken }), 401, "unauthorized");
  assert.equal(f.home.mints.length, 0);
});

test("claim returns credentials once and storage keeps only digests and ciphertext", async () => {
  const f = await fixture();
  const { value: issued } = await f.create();
  const beforeClaim = await f.storage.serialized();
  assert.ok(!beforeClaim.includes(modelKey));
  assert.ok(!beforeClaim.includes(toolsToken));
  assert.ok(!beforeClaim.includes(issued.token));

  const response = await claim(f, issued.token);
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json() as { credentials: { modelKey: string; toolsToken: string } };
  assert.equal(payload.credentials.modelKey, modelKey);
  assert.equal(payload.credentials.toolsToken, toolsToken);
  const afterClaim = await f.storage.serialized();
  assert.ok(!afterClaim.includes(modelKey));
  assert.ok(!afterClaim.includes(toolsToken));
  assert.ok(!afterClaim.includes(issued.token));
  assert.equal((await f.storage.snapshot<Record<string, { state: string; link?: unknown }>>("computer-registry-v1"))![issued.computer.id]!.state, "active");
  assert.equal((await f.storage.snapshot<Record<string, { state: string; link?: unknown }>>("computer-registry-v1"))![issued.computer.id]!.link, undefined);

  await expectError(await claim(f, issued.token), 410, "invalid_session", "This setup link has expired or was already used.");
});

test("expired setup claims cannot return credentials", async () => {
  const f = await fixture();
  const { value: issued } = await f.create();
  f.advance(setupTtl);
  await expectError(await claim(f, issued.token), 410, "invalid_session", "This setup link has expired or was already used.");
  const stored = await f.storage.serialized();
  assert.ok(!stored.includes(modelKey));
  assert.ok(!stored.includes(toolsToken));
});

test("refresh replaces the opaque link and preserves the sealed credentials", async () => {
  const f = await fixture();
  const { intent, value: first } = await f.create();
  const refreshedResponse = await f.action("refresh", owner, intent, { id: first.computer.id });
  assert.equal(refreshedResponse.status, 200, await refreshedResponse.clone().text());
  const refreshed = await refreshedResponse.json() as { token: string };
  assert.notEqual(refreshed.token, first.token);
  await expectError(await claim(f, first.token), 410, "invalid_session");

  const response = await claim(f, refreshed.token);
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json() as { credentials: { modelKey: string; toolsToken: string } };
  assert.deepEqual(payload.credentials, { modelUrl: "https://setup.example", modelKey, toolsUrl: "https://setup.example/mcp", toolsToken });
});

test("unknown computer actions share the same generic response and never call Home", async () => {
  const f = await fixture();
  const setup = await f.context();
  const intent = String(setup.value.intent);
  for (const action of ["refresh", "revoke", "rebind", "revoked"]) {
    const response = await f.action(action, owner, intent, { id: "unknown-computer" });
    await expectError(response, 404, "not_found", "This computer does not exist.");
  }
  assert.equal(f.home.mints.length, 0);
  assert.equal(f.home.revoked.length, 0);
  assert.equal(f.home.rebound.length, 0);
});

test("shared pool setup is refused before any computer key can exist", async () => {
  const f = await fixture();
  const member = await f.context(claims, "tools-user-2");
  assert.equal(member.response.status, 403);
  assert.match(String(member.value.message), /Shared pools come with pool sharing/);
  const intent = await signIntent(signingKey, { ...claims, user: "tools-user-2", expiresAt: f.now() + setupTtl });
  const response = await f.action("links", "tools-user-2", intent, { name: "Laptop", toolsKeyId, toolsToken });
  await expectError(response, 403, "not_owner");
  assert.equal(f.home.mints.length, 0);
  assert.deepEqual(f.home.found, []);
  assert.deepEqual(f.home.revoked, []);
  assert.equal(await f.storage.serialized(), "[]");
});

test("model and tools evidence are recorded independently", async () => {
  const f = await fixture();
  const { intent, value: issued } = await f.create();
  const claimed = await claim(f, issued.token);
  assert.equal(claimed.status, 200);

  const toolHash = await digest(toolsToken);
  assert.equal((await f.action("observed", owner, undefined, { tokenHash: toolHash })).status, 200);
  const afterTools = (await f.storage.snapshot<Record<string, { firstToolCallAt: string | null; firstModelRequestAt: string | null }>>("computer-registry-v1"))![issued.computer.id]!;
  assert.ok(afterTools.firstToolCallAt);
  assert.equal(afterTools.firstModelRequestAt, null);
  assert.equal(f.home.observations.length, 0);

  const listed = await f.action("computers", owner, intent);
  assert.equal(listed.status, 200);
  const computers = (await listed.json() as { computers: { firstModelRequestAt: string | null; firstToolCallAt: string | null }[] }).computers;
  assert.equal(computers[0]!.firstModelRequestAt, modelObservedAt);
  assert.equal(computers[0]!.firstToolCallAt, afterTools.firstToolCallAt);
  assert.deepEqual(f.home.observations, [{ pool: claims.pool, keyId: 73, since: "2026-01-01T00:00:00.000Z" }]);
});

test("revoke durably marks revoking and waits for model-key deletion before returning toolsKeyId", async () => {
  const f = await fixture();
  const { intent, value: issued } = await f.create();
  assert.equal((await claim(f, issued.token)).status, 200);

  let release!: () => void;
  let started!: () => void;
  const startedRevoke = new Promise<void>((resolve) => { started = resolve; });
  f.home.revokeGate = new Promise<void>((resolve) => { release = resolve; });
  f.home.onRevoke = started;
  let completed = false;
  const responsePromise = f.action("revoke", owner, intent, { id: issued.computer.id }).then((response) => {
    completed = true;
    return response;
  });
  await startedRevoke;
  assert.deepEqual(f.home.revoked, [73]);
  const duringRevoke = (await f.storage.snapshot<Record<string, { state: string; link?: unknown; revokedAt: string | null }>>("computer-registry-v1"))![issued.computer.id]!;
  assert.equal(duringRevoke.state, "revoking");
  assert.equal(duringRevoke.link, undefined);
  assert.equal(duringRevoke.revokedAt, null);
  assert.equal(completed, false);

  release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { toolsKeyId });
  assert.equal((await f.storage.snapshot<Record<string, { state: string }>>("computer-registry-v1"))![issued.computer.id]!.state, "revoking");

  const finalized = await f.action("revoked", owner, intent, { id: issued.computer.id });
  assert.equal(finalized.status, 200);
  const row = (await f.storage.snapshot<Record<string, { state: string; revokedAt: string | null }>>("computer-registry-v1"))![issued.computer.id]!;
  assert.equal(row.state, "revoked");
  assert.equal(row.revokedAt, new Date(f.now()).toISOString());
});

test("rebind changes the pool on the existing key and clears evidence from the previous binding", async () => {
  const f = await fixture();
  const { value: issued } = await f.create();
  assert.equal((await claim(f, issued.token)).status, 200);
  await f.computers.list(owner, claims.pool);
  await f.action("observed", owner, undefined, { tokenHash: await digest(toolsToken) });
  const before = (await f.computers.list(owner, claims.pool))[0]!;
  assert.equal(before.firstModelRequestAt, modelObservedAt);
  assert.ok(before.firstToolCallAt);

  const destination = { ...claims, pool: "pool-b" };
  const target = await f.context(destination, owner);
  const targetIntent = String(target.value.intent);
  f.advance(1_000);
  const response = await f.action("rebind", owner, targetIntent, { id: issued.computer.id });
  assert.equal(response.status, 200, await response.clone().text());
  const rebound = await response.json() as { id: string; poolId: string; createdAt: string; firstModelRequestAt: string | null; firstToolCallAt: string | null };
  assert.equal(rebound.poolId, "pool-b");
  assert.equal(rebound.createdAt, issued.computer.createdAt);
  assert.equal(rebound.firstModelRequestAt, null);
  assert.equal(rebound.firstToolCallAt, before.firstToolCallAt);
  assert.deepEqual(f.home.rebound, [{ keyId: 73, pool: "pool-b" }]);
  assert.equal(f.home.mints.length, 1);
  assert.ok(!(await f.storage.serialized()).includes(modelKey));
});

test("failed mint remains recoverable by the Home display tag before tools access is returned", async () => {
  const f = await fixture();
  f.home.mintFailure = new Error("backend timed out after create");
  f.home.orphanKeyIds = [91];
  const setup = await f.context();
  const intent = String(setup.value.intent);
  const failed = await f.action("links", owner, intent, { name: "Workstation", toolsKeyId, toolsToken });
  await expectError(failed, 503, "backend_unavailable");
  assert.equal(f.home.mints.length, 1);
  f.home.mintFailure = undefined;

  const pendingList = await f.action("computers", owner, intent);
  assert.equal(pendingList.status, 200);
  const computer = (await pendingList.json() as { computers: { id: string; state: string }[] }).computers[0]!;
  assert.equal(computer.state, "issuing");
  const revoked = await f.action("revoke", owner, intent, { id: computer.id });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.deepEqual(f.home.found, [computer.id]);
  assert.deepEqual(f.home.revoked, [91]);
  assert.deepEqual(await revoked.json(), { toolsKeyId });
});
