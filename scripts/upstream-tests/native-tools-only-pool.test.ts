// A device approved for tools only reaches the person's own tools. Its approval, access checks and
// token refreshes must keep working while the pool's control plane is down; a device with models
// still asks the pool every time. The pool here is the real control endpoint, served over HTTP.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fixture } from "./native-device-fixture.ts";
import { fixture as poolFixture, pool } from "../../src/pool/test/computers.ts";
import { nativeControlPath } from "../../src/pool/native-contract.ts";
import { failureResponse } from "../../src/pool/json.ts";
import { handleSetup } from "../../src/setup/host.ts";
import { tunnelAccess, tunnelLease } from "../../src/tunnel/access.ts";

const origin = "http://localhost:3000";
const form = { "content-type": "application/x-www-form-urlencoded" };

/** The pool's control endpoint; once `fail` is called it answers as its Worker does in an outage. */
async function runningPool(t: TestContext) {
  const p = poolFixture();
  let failing = false;
  let asked = 0;
  const server = createServer(async (incoming, outgoing) => {
    asked++;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    // The host signs its assertions with the real clock; the pool's clock follows it.
    p.advance(Date.now() - p.now());
    const url = new URL(incoming.url ?? "/", "http://pool.invalid");
    const response =
      failing || url.pathname !== nativeControlPath
        ? failureResponse(new Error("synthetic controller outage"))
        : await p.nativeControl(
            new Request(url, { method: incoming.method, body: Buffer.concat(chunks) }),
          );
    outgoing.writeHead(response.status, { "content-type": "application/json" });
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return {
    p,
    origin: `http://127.0.0.1:${port}`,
    fail: () => {
      failing = true;
    },
    recover: () => {
      failing = false;
    },
    failing: () => failing,
    asked: () => asked,
  };
}

/** The host and pool a device is approved against; nothing is decided yet. */
async function host(t: TestContext) {
  const running = await runningPool(t);
  // SQL rows, as production reads them: the memory adapter returns fields a schema refuses.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const f = await fixture(undefined, undefined, db, {
    organizations: true,
    poolOrigin: running.origin,
  });
  t.after(() => f[Symbol.dispose]());
  const team = (
    await f.adapter.create<{ id: string }>({
      model: "organization",
      data: { name: "Tools", slug: "tools", createdAt: new Date() },
    })
  ).id;
  await f.adapter.create({
    model: "member",
    data: { organizationId: team, userId: f.userId, role: "owner", createdAt: new Date() },
  });
  running.p.advance(Date.now() - running.p.now());
  const intent = await running.p.intent(f.userId, { ...pool, owner: f.userId, organization: team });
  const decide = (models: boolean) =>
    f.request(
      "/device/decide",
      { user_code: f.user_code, accept: true },
      {
        "x-basalt-native-intent": intent,
        "x-basalt-native-name": models ? "Models device" : "Work laptop",
        "x-basalt-native-pool": pool.pool,
        "x-basalt-native-models": String(models),
        "x-basalt-native-tools": "true",
      },
    );
  const issue = async () => {
    const issued = await f.raw("/oauth2/token", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: f.device_code,
        client_id: f.client_id,
        code_verifier: f.verifier,
        resource: `${origin}/native`,
      }),
    });
    assert.equal(issued.status, 200, await issued.clone().text());
    return (await issued.json()) as { access_token: string; refresh_token: string };
  };
  const access = (bearer: string) =>
    f.raw("/native/access", { headers: { authorization: `Bearer ${bearer}` } });
  const refresh = (token: string) =>
    f.raw("/oauth2/token", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: f.client_id,
        resource: `${origin}/native`,
      }),
    });
  const signOut = (bearer: string) =>
    f.raw("/native/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: "{}",
    });
  /** The Connect page, as the person's browser calls it, with the real host and pool behind it. */
  const env = {
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    TOOLS_SERVICE: { fetch: (request: Request) => f.handler(request) },
    POOL_SERVICE: {
      fetch: async (request: Request) => {
        if (running.failing()) return failureResponse(new Error("synthetic controller outage"));
        running.p.advance(Date.now() - running.p.now());
        return running.p.setup(request);
      },
    },
  };
  const connect = (path: string, method = "GET") =>
    handleSetup(
      new Request(`${origin}/setup/v1/computers${path}?intent=${encodeURIComponent(intent)}`, {
        method,
        headers: { cookie: f.cookies, origin },
      }),
      env,
    );
  const listed = async () => {
    const response = await connect("");
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { computers: Record<string, unknown>[] }).computers;
  };
  return {
    ...running,
    f,
    team,
    intent,
    decide,
    issue,
    access,
    refresh,
    signOut,
    env,
    connect,
    listed,
  };
}

/** A device approved through the real decide endpoint, with its first tokens. */
async function device(t: TestContext, models: boolean) {
  const h = await host(t);
  const approved = await h.decide(models);
  assert.equal(approved.status, 200, await approved.clone().text());
  return { ...h, tokens: await h.issue() };
}

test("a tools-only device keeps its access check and refresh while the pool's control plane fails", async (t) => {
  const d = await device(t, false);
  d.fail();
  const asked = d.asked();
  const checked = await d.access(d.tokens.access_token);
  assert.equal(checked.status, 200, await checked.clone().text());
  const answer = await checked.json();
  assert.equal(answer.policy.models, false);
  assert.equal(answer.policy.toolsOrganization, d.team);
  assert.deepEqual(answer.display, {
    account: { name: "Device owner", email: "device-owner@example.invalid", emailVerified: true },
    pool: { id: pool.pool, name: "" },
    pools: [],
  });
  const refreshed = await d.refresh(d.tokens.refresh_token);
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const next = (await refreshed.json()) as { access_token: string };
  const again = await d.access(next.access_token);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(d.asked(), asked, "a tools-only device asks the pool nothing");
});

test("a tools-only device is still refused once it leaves its tools team", async (t) => {
  const d = await device(t, false);
  d.fail();
  await d.f.adapter.deleteMany({
    model: "member",
    where: [
      { field: "userId", value: d.f.userId },
      { field: "organizationId", value: d.team },
    ],
  });
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
  const refreshed = await d.refresh(d.tokens.refresh_token);
  assert.equal(refreshed.status, 400, await refreshed.clone().text());
  assert.equal((await refreshed.json()).error, "invalid_grant");
});

test("a device with models still asks the pool on every check and refresh", async (t) => {
  const d = await device(t, true);
  const before = d.asked();
  const checked = await d.access(d.tokens.access_token);
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.equal(d.asked(), before + 1, "the pool answers for a device with models");
  d.fail();
  const down = d.asked();
  assert.equal((await d.access(d.tokens.access_token)).status, 503);
  assert.equal(d.asked(), down + 1);
  assert.equal((await d.refresh(d.tokens.refresh_token)).status, 503);
  assert.ok(d.asked() > down + 1, "the refresh asked the pool too");
});

test("revoking a tools-only device on Connect signs it out at the tools service", async (t) => {
  const d = await device(t, false);
  const [computer] = Object.keys(await d.p.registry());
  assert.ok(computer, "the pool heard of the device it was answering for");
  // A device without a model key holds nothing at Home, so a stopped container changes nothing.
  d.p.server.stopped = true;
  const removed = await d.connect(`/${computer}`, "DELETE");
  assert.equal(removed.status, 200, await removed.clone().text());
  const grant = await d.f.adapter.findOne<{ revoked: boolean }>({
    model: "mcpGrant",
    where: [{ field: "userId", value: d.f.userId }],
  });
  assert.equal(grant?.revoked, true, "the device's grant is revoked as the person");
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
  assert.equal((await d.refresh(d.tokens.refresh_token)).status, 400);
  assert.equal((await d.p.registry())[computer]?.state, "revoked");
});

test("a tools-only device is approved and reaches its tools while the pool's control plane fails", async (t) => {
  const h = await host(t);
  h.fail();
  const asked = h.asked();
  const approved = await h.decide(false);
  assert.equal(approved.status, 200, await approved.clone().text());
  const tokens = await h.issue();
  const checked = await h.access(tokens.access_token);
  assert.equal(checked.status, 200, await checked.clone().text());
  const { policy } = (await checked.json()) as { policy: Record<string, unknown> };
  assert.equal(policy.models, false);
  assert.equal(policy.toolsOrganization, h.team);
  assert.equal(policy.pool, pool.pool);
  // Its tool calls go through the tunnel, which admits it with its own bearer and holds nothing
  // at the pool.
  const tunnel = new Request(`${origin}/native/v1/tunnel`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${tokens.access_token}` },
  });
  const admitted = await tunnelAccess(tunnel, h.env);
  assert.ok(!(admitted instanceof Response), "the tunnel admits the device");
  assert.equal(await tunnelLease(tunnel, h.env, admitted), undefined);
  const refreshed = await h.refresh(tokens.refresh_token);
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  // The pool's outage cost nothing: approving told it at most once, and nothing waited on it.
  assert.ok(h.asked() <= asked + 1, `the pool was asked ${h.asked() - asked} times`);
});

test("a device with models is still refused while the pool's control plane fails", async (t) => {
  const h = await host(t);
  h.fail();
  const approved = await h.decide(true);
  assert.equal(approved.status, 503, await approved.clone().text());
  assert.equal(
    await h.f.adapter.findOne({
      model: "mcpGrant",
      where: [{ field: "userId", value: h.f.userId }],
    }),
    null,
    "nothing was approved",
  );
});

test("once the pool answers, Connect lists a tools-only device approved while it failed", async (t) => {
  const h = await host(t);
  h.fail();
  assert.equal((await h.decide(false)).status, 200);
  const tokens = await h.issue();
  const { policy } = (await (await h.access(tokens.access_token)).json()) as {
    policy: { computer: string };
  };
  assert.deepEqual(await h.p.registry(), {}, "the failing pool heard nothing");
  h.recover();
  const computers = await h.listed();
  assert.equal(computers.length, 1, JSON.stringify(computers));
  assert.equal(computers[0]?.id, policy.computer);
  assert.equal(computers[0]?.state, "active");
  assert.equal(computers[0]?.tools, true);
  assert.equal(computers[0]?.poolId, pool.pool);
  assert.equal((await h.listed()).length, 1, "listing again adds nothing");
  // Its Connect revoke now works like any other device's.
  assert.equal((await h.connect(`/${policy.computer}`, "DELETE")).status, 200);
  assert.equal((await h.access(tokens.access_token)).status, 401);
  assert.equal((await h.listed())[0]?.state, "revoked");
});

test("a tools-only device the pool answered for is listed under its chosen name at once", async (t) => {
  const d = await device(t, false);
  const computers = await d.listed();
  assert.equal(computers.length, 1, JSON.stringify(computers));
  assert.equal(computers[0]?.name, "Work laptop");
});

test("a tools-only device signs out while the pool fails, whether or not the pool heard of it", async (t) => {
  const unknown = await host(t);
  unknown.fail();
  assert.equal((await unknown.decide(false)).status, 200);
  const unlisted = await unknown.issue();
  const out = await unknown.signOut(unlisted.access_token);
  assert.equal(out.status, 200, await out.clone().text());
  assert.equal((await unknown.access(unlisted.access_token)).status, 401);
  unknown.recover();
  assert.deepEqual(await unknown.listed(), [], "a signed-out device is never listed");

  const known = await device(t, false);
  const [computer] = Object.keys(await known.p.registry());
  known.fail();
  const signedOut = await known.signOut(known.tokens.access_token);
  assert.equal(signedOut.status, 200, await signedOut.clone().text());
  assert.equal((await known.access(known.tokens.access_token)).status, 401);
  // Connect still lists it until the person removes it there, which finishes without the grant.
  known.recover();
  assert.equal((await known.connect(`/${computer}`, "DELETE")).status, 200);
  assert.equal((await known.p.registry())[computer!]?.state, "revoked");
});
