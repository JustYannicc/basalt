import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { callerHeader } from "../../apps/pool/contract.ts";
import { accessPath, accessPrefix, accessTtl, type AccessChange } from "../../src/pool/access-contract.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { backendUserName, personPrefix } from "../../src/pool/backend-users.ts";
import { Computers } from "../../src/pool/computers.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { signEnvelope, signPoolToken, type PoolClaims } from "../../src/pool/token.ts";
import { MemoryStorage, SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

const origin = "https://pool.example.test";
const signingKey = "ab".repeat(32);
const A = "a@example.test";
const B = "b@example.test";
const P1 = { pool: "p1.example.test", owner: A, organization: "org-a.example.test" };
const P2 = { pool: "p2.example.test", owner: B, organization: "org-b.example.test" };
const toolsToken = "fixture-tools-token-b";
const toolsKeyId = "fixture-tools-key-b";

async function ok<T>(response: Response): Promise<T> {
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as T;
}

test("real pinned Home/node: share, claim, switch, remove during stream, delete person", { timeout: 420_000 }, async () => {
  const fixture = new SharingFixture();
  try {
    await fixture.start();
    const client = new HomeClient((input, init) => fixture.fetchHome(input, init));
    const home = new ComputerHome(client);
    const computers = new Computers({ storage: new MemoryStorage(), home, signingKey, origin });
    const tokenP1 = await signPoolToken(signingKey, P1);
    const tokenP2 = await signPoolToken(signingKey, P2);
    const audience = (claims: PoolClaims, users: string[]) => ({ ...claims, name: claims.pool, users });
    async function access(change: AccessChange) {
      const at = Date.now();
      const envelope = await signEnvelope(signingKey, accessPrefix, { ...change, at, expiresAt: at + accessTtl });
      return computers.access(new Request(`${origin}${accessPath}`, {
        method: "POST", body: JSON.stringify({ envelope }),
      }));
    }
    async function context(token: string, user = B) {
      return ok<{ intent: string; pools: { id: string }[]; shareHref?: string }>(await computers.context(new Request(`${origin}/pool/v1/computers/context`, {
        headers: { Authorization: `Bearer ${token}`, [callerHeader]: user },
      })));
    }
    async function action(action: string, intent?: string, extra: Record<string, unknown> = {}) {
      const envelope = await signEnvelope(signingKey, "sbs1", { ...extra, user: B, intent, action, expiresAt: Date.now() + 30_000 });
      return computers.handle(new Request(`${origin}/setup/${action}`, { method: "POST", body: JSON.stringify({ envelope }) }));
    }
    async function create(intent: string, name: string) {
      const created = await ok<{ computer: { id: string }; token: string }>(await action("links", intent, { name, toolsKeyId, toolsToken }));
      const claimed = await ok<{ credentials: { modelUrl: string; modelKey: string; toolsUrl: string; toolsToken: string } }>(
        await action("claim", undefined, { token: created.token, format: "json" }));
      assert.deepEqual(Object.keys(claimed.credentials).sort(), ["modelKey", "modelUrl", "toolsToken", "toolsUrl"]);
      assert.deepEqual(claimed.credentials, { modelUrl: origin, modelKey: claimed.credentials.modelKey, toolsUrl: `${origin}/mcp`, toolsToken });
      const secretPayload = JSON.stringify(claimed);
      for (const secret of ["fixture-p1", "fixture-p2", fixture.managementKey, tokenP1, tokenP2]) assert.ok(!secretPayload.includes(secret));
      const key = (await fixture.keys()).find((key) => key.display_name === `${brand.setup.id}:${created.computer.id}`);
      assert.ok(key);
      assert.equal(claimed.credentials.modelKey, key.api_key);
      assert.equal((await action("claim", undefined, { token: created.token, format: "json" })).status, 410);
      return { id: created.computer.id, modelKey: claimed.credentials.modelKey, keyId: key.api_key_id };
    }
    async function turn(key: string, expectedPool: "P1" | "P2", session: string) {
      const before = fixture.calls.length;
      const response = await fixture.model(key, session);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, new RegExp(`"content":"${expectedPool}"`));
      assert.match(body, /data: \[DONE\]/);
      assert.deepEqual(fixture.calls.slice(before), [`Bearer fixture-${expectedPool.toLowerCase()}`]);
    }
    async function refused(key: string, session: string) {
      const before = fixture.calls.length;
      const response = await fixture.model(key, session);
      const body = await response.text();
      assert.equal(response.status, 401, body);
      assert.match(body, /invalid.*key|unauthoriz|authentication/i);
      assert.equal(fixture.calls.length, before, "An unauthorized request must never reach the provider");
      console.log(`Node refusal: ${response.status} ${body}`);
    }

    // Config reads return canonical credential ids even though /credentials excludes config keys.
    // Pinned Home: internal/cluster/credential_export.go:282-354 and
    // internal/cluster/management/channel_groups.go:188-218 at eca75d683c89c1e66a07865d9de530c6cae3ef9f.
    const providers = await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility");
    for (const [claims, provider] of [[P1, "fixture-p1"], [P2, "fixture-p2"]] as const) {
      const matches = providers.filter((row) => row.name === provider);
      assert.equal(matches.length, 1, JSON.stringify(providers));
      assert.equal(matches[0]!.keys.length, 1);
      const credential = matches[0]!.keys[0]!;
      assert.match(credential.id, /^[0-9a-f-]{36}$/);
      assert.equal(credential["api-key"], provider);
      await new PoolHome(client, claims.pool).add([credential.id]);
      const membership = await new PoolHome(client, claims.pool).membership();
      assert.deepEqual(membership.members.map((row) => row.auth_id), [credential.id]);
      assert.equal(membership.groups.length, 1);
    }
    console.log("PASS fixture: two distinct Home accounts, each attached only to its own pool channel group");

    const usernameB = await backendUserName(B, P1.pool);
    assert.ok(!(await fixture.users()).some((row) => row.username === usernameB));
    assert.deepEqual(await ok(await access({ action: "audience", pools: [audience(P1, [A, B]), audience(P2, [B])] })), { revoked: 0, provisioned: 1 });
    const userB = (await fixture.users()).find((row) => row.username === usernameB);
    assert.ok(userB, "Sharing must provision B before the access call returns 200");
    console.log("PASS 1: signed audience change returned 200 and provisioned B in real Home");

    const setup = await context(tokenP1);
    assert.equal(setup.shareHref, undefined, "B is a non-owner caller");
    assert.deepEqual(setup.pools.map((pool) => pool.id), [P1.pool]);
    const browserView = await ok<{ pools: { id: string }[] }>(await action("computers", setup.intent));
    assert.deepEqual(new Set(browserView.pools.map((pool) => pool.id)), new Set([P1.pool, P2.pool]));
    const computer = await create(setup.intent, "Shared computer");
    const issued = (await fixture.keys()).find((key) => key.api_key_id === computer.keyId)!;
    assert.equal(issued.user_id, userB.id);
    assert.deepEqual(issued.channels, [await home.group(P1.pool)]);
    await turn(computer.modelKey, "P1", "same-computer-session");
    console.log("PASS 2: non-owner setup, one-time claim, only B's model key and tools token, real P1 request");

    const beforeSwitch = await fixture.keys();
    const mintCount = () => fixture.events.filter((event) => event.method === "POST" && event.path === "/v8/management/access/api-keys").length;
    const initialMints = mintCount();
    for (const [claims, expected] of [[P2, "P2"], [P1, "P1"]] as const) {
      const switched = await ok<{ poolId: string }>(await action("switch", setup.intent, { id: computer.id, pool: claims.pool }));
      assert.equal(switched.poolId, claims.pool);
      const after = await fixture.keys();
      assert.deepEqual(after.map((key) => key.api_key_id), beforeSwitch.map((key) => key.api_key_id));
      assert.equal(mintCount(), initialMints, "Switch must never create another Home key");
      const key = after.find((key) => key.api_key_id === computer.keyId)!;
      assert.equal(key.api_key, computer.modelKey);
      assert.deepEqual(key.channels, [await home.group(claims.pool)]);
      const targetName = await backendUserName(B, claims.pool);
      assert.equal(key.user_id, (await fixture.users()).find((user) => user.username === targetName)?.id);
      // Same session and unchanged client key: test the very next request without retries.
      await turn(computer.modelKey, expected, "same-computer-session");
    }
    console.log("PASS 3: P1 -> P2 -> P1, unchanged key id and secret, zero new keys, next request uses selected account");

    const stale = await context(tokenP1);
    const streaming = await fixture.model(computer.modelKey, "slow-session", true);
    assert.equal(streaming.status, 200);
    const reader = streaming.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const decoder = new TextDecoder();
    let stream = decoder.decode(first.value, { stream: true });
    assert.match(stream, /P1/);
    assert.equal(fixture.slowStarted, true);
    assert.equal(fixture.slowFinished, false);
    const eventStart = fixture.events.length;
    assert.deepEqual(await ok(await access({ action: "audience", pools: [audience(P1, [A])] })), { revoked: 1, provisioned: 0 });
    assert.ok(fixture.events.slice(eventStart).some((event) => event.method === "DELETE"
      && event.path === `/v8/management/access/api-keys?id=${computer.keyId}` && event.status === 200));
    assert.ok(!(await fixture.keys()).some((key) => key.api_key_id === computer.keyId));
    assert.equal(fixture.slowFinished, false, "Access removal must acknowledge while the old stream is still running");
    await refused(computer.modelKey, "next-after-removal");
    fixture.finishStream();
    for (;;) { const part = await reader.read(); if (part.done) break; stream += decoder.decode(part.value, { stream: true }); }
    stream += decoder.decode();
    assert.match(stream, /data: \[DONE\]/);
    for (const content of [" slow", " stream", " complete"]) assert.ok(stream.includes(`"content":"${content}"`));
    assert.equal(fixture.slowFinished, true);
    assert.equal((await computers.list(B)).find((row) => row.id === computer.id)?.state, "removed");
    const keysAfterRemoval = await fixture.keys();
    for (const name of ["links", "switch"]) {
      const response = await action(name, stale.intent, { id: computer.id, pool: P2.pool, name: "Must refuse", toolsKeyId, toolsToken });
      assert.equal(response.status, 403, await response.clone().text());
      assert.match(await response.text(), /Access to this pool was removed/);
    }
    assert.deepEqual(await fixture.keys(), keysAfterRemoval);
    console.log("PASS 4: removal acknowledged after Home deletion; old stream completed; next request 401; computer removed; stale links/switch refused");

    const ownSetup = await context(tokenP2);
    const remaining = await create(ownSetup.intent, "Own pool computer");
    await turn(remaining.modelKey, "P2", "before-person-deleted");
    const ownUserName = await backendUserName(B, P2.pool);
    const ownUser = (await fixture.users()).find((user) => user.username === ownUserName)!;
    assert.equal((await fixture.keys()).filter((key) => key.user_id === ownUser.id).length, 1);
    assert.deepEqual(await ok(await access({ action: "person-deleted", user: B })), { revoked: 1, provisioned: 0 });
    assert.ok(!(await fixture.keys()).some((key) => key.user_id === userB.id));
    const prefixB = await personPrefix(B);
    assert.ok(!(await fixture.users()).some((row) => row.username.startsWith(prefixB)));
    assert.ok((await computers.list(B)).every((row) => row.state === "removed"));
    await refused(remaining.modelKey, "next-after-account-deletion");
    console.log("PASS 5: person-deleted removed B's remaining P2 key and Home user; node refused that key");
  } finally {
    await fixture.close();
  }
});
