import assert from "node:assert/strict";
import { test } from "node:test";
import { AppModels } from "./app-models.ts";
import { appModelPath, appModelPrefix, parseAppModelLabel } from "./app-model-contract.ts";
import { fixture, owner, pool, signingKey } from "./test/computers.ts";
import { signEnvelope } from "./token.ts";

const app = "app_11111111-1111-4111-8111-111111111111";
const person = "app-user-without-pool-access";
const result = { id: "completion-one", object: "chat.completion", created: 1, model: "fixture",
  choices: [{ index: 0, message: { role: "assistant", content: '{"intent":"reply"}' }, finish_reason: "stop" }] };
async function setup() {
  const f = fixture();
  assert.equal((await f.access({ action: "audience", pools: [{ ...pool, users: [owner],
    managers: [owner], authorization: "executor-app-v1" }] })).status, 200);
  const sent: { request: Request; identity: unknown; body: unknown }[] = [];
  const schedule: number[] = [];
  let ready = true;
  let forward = async (request: Request): Promise<Response> => {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    assert.equal(f.server.keys.length, 1);
    return Response.json(result);
  };
  const make = () => new AppModels({ storage: f.storage, home: f.home, signingKey,
    now: f.now, schedule: async (at) => { schedule.push(at); }, ready: async () => ready,
    forward: async (request, identity) => {
      sent.push({ request, identity, body: await request.clone().json() });
      return forward(request);
    },
  });
  let service = make();
  const assertion = (overrides: Record<string, unknown> = {}) => ({
    nonce: crypto.randomUUID(), expiresAt: f.now() + 10_000, ...pool,
    app, requirement: "email", binding: "binding-one", revision: 1,
    person, authorizer: owner, scope: "app", background: false, timeoutMs: 30_000,
    body: { model: "fixture", messages: [{ role: "user", content: "Classify this email" }], stream: false, n: 1, max_tokens: 20 },
    ...overrides,
  });
  const request = async (value = assertion(), signal?: AbortSignal, secret = signingKey) =>
    new Request(`https://pool.example${appModelPath}`, { method: "POST", signal,
      headers: { authorization: "Bearer untrusted-client-key", cookie: "unrelated=private" },
      body: JSON.stringify({ envelope: await signEnvelope(secret, appModelPrefix, value) }),
    });
  return { f, sent, schedule, assertion, request, handle: (r: Request) => service.handle(r),
    restart: () => { service = make(); }, tick: () => service.tick(),
    unavailable: () => { ready = false; }, forward: (next: typeof forward) => { forward = next; },
  };
}

test("an app delegates its pool while the caller keeps their own capped Home user and no key escapes", async () => {
  const s = await setup();
  const response = await s.handle(await s.request());
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), result);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0]?.identity, { pool: pool.pool, person, keyId: 70, appId: app, requirement: "email" });
  const created = s.f.server.calls.find((call) => call.path === "/access/api-keys" && call.method === "POST")?.body;
  assert.ok(created);
  assert.deepEqual(created.channels, [10]);
  const name = await s.f.userName(person);
  const caller = s.f.server.users.find((row) => row.username === name);
  assert.ok(caller);
  assert.equal(created.user_id, caller.id);
  assert.deepEqual(parseAppModelLabel(created.display_name), { app, requirement: "email" });
  assert.equal(s.sent[0]?.request.headers.has("cookie"), false);
  assert.notEqual(s.sent[0]?.request.headers.get("authorization"), "Bearer untrusted-client-key");
  assert.equal(s.f.server.keys.length, 0);
  assert.equal(JSON.stringify([...s.f.storage.values.values()]).includes(String(created.api_key)), false);
});

test("a signed nonce is admitted once across concurrent calls and object restart", async () => {
  const s = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  s.forward(async () => { entered.resolve(); await release.promise; return Response.json(result); });
  const value = s.assertion();
  const first = s.handle(await s.request(value));
  await entered.promise;
  assert.equal((await s.handle(await s.request(value))).status, 409);
  release.resolve();
  assert.equal((await first).status, 200);
  s.restart();
  assert.equal((await s.handle(await s.request(value))).status, 409);
  assert.equal(s.sent.length, 1);
});

test("revoked authority missing attribution readiness and forged assertions never mint a key", async () => {
  const s = await setup();
  for (const [overrides, status] of [
    [{ organization: "other-org" }, 403], [{ authorizer: "removed-person" }, 403],
    [{ scope: "user" }, 400], [{ expiresAt: s.f.now() }, 401],
  ] as const) assert.equal((await s.handle(await s.request(s.assertion(overrides)))).status, status);
  assert.equal((await s.handle(await s.request(s.assertion(), undefined, "cd".repeat(32)))).status, 401);
  s.unavailable();
  assert.equal((await s.handle(await s.request())).status, 503);
  assert.equal(s.sent.length, 0);
  assert.equal(s.f.server.keys.length, 0);
  assert.equal(s.f.server.calls.filter((call) => call.path === "/access/api-keys" && call.method === "POST").length, 0);
});

test("cancellation reaches the generation and failed key retirement recovers after restart", async () => {
  const s = await setup();
  const entered = Promise.withResolvers<void>();
  s.forward(async (request) => {
    entered.resolve();
    await new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    return Response.json(result);
  });
  const controller = new AbortController();
  const work = s.handle(await s.request(s.assertion(), controller.signal));
  await entered.promise;
  s.f.server.revokeFailure = true;
  controller.abort();
  assert.equal((await work).status, 503);
  assert.equal(s.sent[0]?.request.signal.aborted, true);
  assert.equal(s.f.server.keys.length, 1);
  assert.ok(s.schedule.some((at) => at === s.f.now() + 5_000));
  s.restart();
  s.f.server.revokeFailure = false;
  await s.tick();
  assert.equal(s.f.server.keys.length, 0);
  assert.equal(s.sent.length, 1);
});

test("an uncertain Home key creation is cleaned without ever dispatching inference", async () => {
  const s = await setup();
  s.f.server.mintReplyFailure = true;
  assert.equal((await s.handle(await s.request())).status, 503);
  assert.equal(s.sent.length, 0);
  assert.equal(s.f.server.keys.length, 0);
});
