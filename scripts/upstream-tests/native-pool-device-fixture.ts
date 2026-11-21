// A host whose pool calls reach the pool's real control endpoint over HTTP, and a device approved
// through the host's real decide endpoint with its first tokens.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { fixture } from "./native-device-fixture.ts";
import { fixture as poolFixture, pool } from "../../src/pool/test/computers.ts";
import { nativeControlPath } from "../../src/pool/native-contract.ts";
import { failureResponse } from "../../src/pool/json.ts";

export const origin = "http://localhost:3000";
const form = { "content-type": "application/x-www-form-urlencoded" };

/** The pool's control endpoint; while failing it answers as its Worker does in an outage. */
export async function runningPool(t: TestContext) {
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
    /** Whether the pool's control plane is failing; its setup API shares that failure. */
    down: () => failing,
    asked: () => asked,
  };
}

/** A device approved through the real decide endpoint, with its first tokens. */
export async function device(t: TestContext, models: boolean) {
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
  return { ...running, f, db, team, intent, tokens, access, refresh };
}
