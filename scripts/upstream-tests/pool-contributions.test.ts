import assert from "node:assert/strict";
import { test } from "node:test";
// The pool app imports the tools-service framework, which exists only once .upstream is prepared.
import app from "../../apps/pool/index.ts";
import { callerHeader } from "../../apps/pool/contract.ts";
import { loginFileMethod } from "../../apps/pool/sign-in.ts";
import { accessGrace, accessPrefix, accessTtl } from "../../src/pool/access-contract.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { Computers } from "../../src/pool/computers.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { fixture, provider, signingKey } from "../../src/pool/test/control.ts";
import { signEnvelope, signPoolToken } from "../../src/pool/token.ts";

async function connectedApp(caller: string | null) {
  const f = await fixture();
  const token = await signPoolToken(signingKey, { pool: "pool-a", owner: "fake-owner", organization: "fake-org" });
  const removals: number[] = [];
  let dropRemovalResponse = false;
  const context = {
    app: { accounts: { pool: { headers: () => ({ Authorization: `Bearer ${token}` }) }, subscriptions: [] } },
    ...(caller === null ? {} : { user: { id: caller } }),
    fetch: async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      const response = await f.call(url.pathname.slice("/pool/v1".length) + url.search, {
        method: init.method, raw: typeof init.body === "string" ? init.body : undefined,
        caller: headers.get(callerHeader), token: headers.get("Authorization")?.slice(7),
      });
      if (init.method === "DELETE") {
        removals.push(response.status);
        if (dropRemovalResponse) {
          dropRemovalResponse = false;
          await response.body?.cancel();
          throw new Error("Synthetic lost removal response");
        }
      }
      return response;
    },
  };
  const definition = await app.evaluate({} as never);
  const home = new ComputerHome(new HomeClient(f.home.fetch));
  home.user = async () => 1;
  const computers = new Computers({ storage: f.storage, home, signingKey, now: f.now, contributions: f.contributions });
  const audience = async (users: string[]) => {
    const at = f.now();
    const envelope = await signEnvelope(signingKey, accessPrefix, {
      action: "audience", at, expiresAt: at + accessTtl,
      pools: [{ pool: "pool-a", owner: "fake-owner", organization: "fake-org", name: "Pool", users }],
    });
    const response = await computers.access(new Request("https://pool.example/pool/v1/access", {
      method: "POST", body: JSON.stringify({ envelope }),
    }));
    assert.equal(response.status, 200, await response.text());
  };
  return { ...f, context: context as never, hook: definition.connect.subscriptions, removals,
    audience, dropNextRemovalResponse: () => { dropRemovalResponse = true; } };
}

test("the subscription remove hook throws the Worker's fixed owner-or-contributor refusal", async () => {
  const f = await connectedApp("fake-manager");
  const uploaded = await f.call("/login-files", { caller: "fake-member", body: { type: provider } });
  const { accountId } = await uploaded.json() as { accountId: string };
  await assert.rejects(f.hook.remove(f.context, { method: loginFileMethod, ref: accountId }), {
    message: "Only the pool's owner or the person who added it can remove this subscription.",
  });
  assert.ok(f.home.files.has(accountId));
});

test("the Accounts login-file hook lets a member connect their own subscription", async () => {
  const f = await connectedApp("fake-member");
  const result = await f.hook.submit(f.context, { method: loginFileMethod, session: "", value: JSON.stringify({ type: provider }) });
  assert.equal(result.state, "connected");
  assert.ok("ref" in result);
  const view = await (await f.call("/pool")).json() as { accounts: { id: string; addedBy: string }[] };
  assert.equal(view.accounts.find((row) => row.id === result.ref)?.addedBy, "fake-member");
  await f.hook.remove(f.context, { method: loginFileMethod, ref: result.ref });
  assert.ok(!f.home.files.has(result.ref));
});

test("the callerless subscription remove hook retries a lost successful departure response after restart", async () => {
  const f = await connectedApp(null);
  const uploaded = await f.call("/login-files", { caller: "fake-member", body: { type: provider } });
  const { accountId } = await uploaded.json() as { accountId: string };
  await f.audience(["fake-owner"]);
  f.dropNextRemovalResponse();
  await assert.rejects(f.hook.remove(f.context, { method: loginFileMethod, ref: accountId }), {
    message: "Synthetic lost removal response",
  });
  assert.ok(!f.home.files.has(accountId));
  f.advance(accessGrace + 1);
  await f.audience(["fake-owner", "fake-member"]);
  const beforeRetry = f.home.calls.length;
  f.restart();
  await f.hook.remove(f.context, { method: loginFileMethod, ref: accountId });
  assert.deepEqual(f.removals, [200, 404]);
  assert.equal(f.home.calls.length, beforeRetry, "The receipt never calls Home again");
});

test("completed departure receipts match only their pool, credential and pool owner", async () => {
  const f = await connectedApp(null);
  const uploaded = await f.call("/login-files", { caller: "fake-member", body: { type: provider } });
  const { accountId } = await uploaded.json() as { accountId: string };
  await f.audience(["fake-owner"]);
  await f.hook.remove(f.context, { method: loginFileMethod, ref: accountId });
  const anotherOwner = await signPoolToken(signingKey, { pool: "pool-a", owner: "another-owner", organization: "fake-org" });
  const before = f.home.calls.length;
  for (const options of [{ pool: "pool-b" }, { token: anotherOwner }, { token: "invalid-token" }]) {
    const response = await f.call(`/accounts/${accountId}`, { method: "DELETE", caller: null, ...options });
    assert.equal(response.status, 401);
  }
  await assert.rejects(f.hook.remove(f.context, { method: loginFileMethod, ref: "another-credential" }), {
    message: "A signed-in pool caller is required.",
  });
  assert.equal(f.home.calls.length, before);
});

test("a completed departure receipt expires after seven days without being extended by retries", async () => {
  const f = await connectedApp(null);
  const uploaded = await f.call("/login-files", { caller: "fake-member", body: { type: provider } });
  const { accountId } = await uploaded.json() as { accountId: string };
  await f.audience(["fake-owner"]);
  await f.hook.remove(f.context, { method: loginFileMethod, ref: accountId });
  f.advance(7 * 24 * 60 * 60_000 - 1);
  f.restart();
  await f.hook.remove(f.context, { method: loginFileMethod, ref: accountId });
  f.advance(1);
  f.restart();
  await assert.rejects(f.hook.remove(f.context, { method: loginFileMethod, ref: accountId }), {
    message: "A signed-in pool caller is required.",
  });
  assert.deepEqual(f.removals, [200, 404, 401]);
  await f.contributions([]);
  const saved = await f.storage.get<{ removals: Record<string, unknown> }>("pool-contributions-v1");
  assert.deepEqual(saved?.removals, {});
});

for (const reuseId of [false, true]) {
  test(`a departure receipt cannot remove a later contribution with ${reuseId ? "a reused" : "a new"} credential id`, async () => {
    const f = await connectedApp(null);
    const first = await f.call("/login-files", { caller: "fake-member", body: { type: provider } });
    const { accountId } = await first.json() as { accountId: string };
    await f.audience(["fake-owner"]);
    await f.hook.remove(f.context, { method: loginFileMethod, ref: accountId });
    f.advance(accessGrace + 1);
    await f.audience(["fake-owner", "fake-member"]);
    if (reuseId) {
      // Model a new Home credential reusing the removed id, without caller-supplied selectors.
      f.home.override = (path, init) => {
        if (path === "/v8/management/credentials" && init?.method === "POST") {
          f.home.addFile(accountId);
          return Response.json({ status: "ok", name: `${accountId}.json` });
        }
        return undefined;
      };
    }
    const next = await f.call("/login-files", { caller: "fake-member", body: { type: provider, refresh_token: "synthetic-new-contribution" } });
    assert.equal(next.status, 200, await next.clone().text());
    const nextId = (await next.json() as { accountId: string }).accountId;
    assert.equal(nextId === accountId, reuseId);
    f.home.override = undefined;
    f.restart();
    const before = f.home.calls.length;
    await assert.rejects(f.hook.remove(f.context, { method: loginFileMethod, ref: nextId }), {
      message: "A signed-in pool caller is required.",
    });
    if (!reuseId) await f.hook.remove(f.context, { method: loginFileMethod, ref: accountId });
    assert.equal(f.home.calls.length, before);
    assert.ok(f.home.files.has(nextId));
    assert.ok(f.home.members.some((row) => row.auth_id === nextId));
  });
}
