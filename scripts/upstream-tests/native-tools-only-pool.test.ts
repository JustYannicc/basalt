// A device approved for tools only reaches the person's own tools. Its access checks and token
// refreshes must keep working while the pool's control plane is down; a device with models still
// asks the pool every time. The pool here is the real control endpoint, served over HTTP.
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
    asked: () => asked,
  };
}

/** A device approved through the real decide endpoint, with its first tokens. */
async function device(t: TestContext, models: boolean) {
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
  const approved = await f.request(
    "/device/decide",
    { user_code: f.user_code, accept: true },
    {
      "x-basalt-native-intent": intent,
      "x-basalt-native-name": models ? "Models device" : "Tools-only device",
      "x-basalt-native-pool": pool.pool,
      "x-basalt-native-models": String(models),
      "x-basalt-native-tools": "true",
    },
  );
  assert.equal(approved.status, 200, await approved.clone().text());
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
  const tokens = (await issued.json()) as { access_token: string; refresh_token: string };
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
  return { ...running, f, team, intent, tokens, access, refresh };
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
  // A device without a model key holds nothing at Home, so a stopped container changes nothing.
  d.p.server.stopped = true;
  const answers: { path: string; status: number; refusal: string }[] = [];
  const removed = await handleSetup(
    new Request(
      `${origin}/setup/v1/computers/${computer}?intent=${encodeURIComponent(d.intent)}`,
      { method: "DELETE", headers: { cookie: d.f.cookies, origin } },
    ),
    {
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      TOOLS_SERVICE: {
        fetch: async (request) => {
          const response = await d.f.handler(request);
          const call = {
            path: new URL(request.url).pathname,
            status: response.status,
            refusal: response.ok ? "" : await response.clone().text(),
          };
          answers.push(call);
          return response;
        },
      },
      POOL_SERVICE: {
        fetch: (request) => {
          d.p.advance(Date.now() - d.p.now());
          return d.p.setup(request);
        },
      },
    },
  );
  assert.equal(removed.status, 200, `${await removed.clone().text()} ${JSON.stringify(answers)}`);
  const grant = await d.f.adapter.findOne<{ revoked: boolean }>({
    model: "mcpGrant",
    where: [{ field: "userId", value: d.f.userId }],
  });
  assert.equal(grant?.revoked, true, "the device's grant is revoked as the person");
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
  assert.equal((await d.refresh(d.tokens.refresh_token)).status, 400);
  assert.equal((await d.p.registry())[computer!]?.state, "revoked");
});

