import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolView, SignInStarted, SignInStatus } from "../../apps/pool/contract.ts";
import { attributionStorageKey, PoolControl, type ControlStorage } from "./attribution.ts";
import { handleControl, HomeClient } from "./control.ts";
import providers from "./providers.json" with { type: "json" };
import { signEnvelope, signPoolToken } from "./token.ts";
import { accountAcquisitionPath, accountAcquisitionPrefix } from "./account-acquisition-contract.ts";
import { subscriptionFailure } from "../../apps/pool/account-health.ts";
import type { Account } from "../../apps/pool/contract.ts";

const signingKey = "ab".repeat(32);
const provider = providers[0]!.id;
const otherProvider = providers[1]!.id;
type Row = Record<string, unknown>;
type Group = { id: number; channel_name: string };
type Member = { id: number; channel_group_id: number; auth_id: string };
type BackendSession = { provider: string; status: string; auth_ids?: string[]; auth_id?: string };
class MemoryStorage implements ControlStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  gets = 0;
  readKeys: string[] = [];
  puts = 0;
  alarmReads = 0;
  async get<T>(key: string): Promise<T | undefined> { this.gets++; this.readKeys.push(key); return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.puts++; this.values.set(key, structuredClone(value)); }
  async getAlarm() { this.alarmReads++; return this.alarm; }
  async setAlarm(time: number) { this.alarm = time; }
}
class FakeHome {
  calls: { path: string; method: string; body?: BodyInit | null }[] = [];
  files = new Map<string, Row>();
  groups: Group[] = [];
  members: Member[] = [];
  quota: Row[] = [];
  usage: Row[] = [];
  ignoreUsageFilters = false;
  sessions = new Map<string, BackendSession>();
  url = "https://login.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback";
  flow: string | undefined;
  duplicateCreate = false;
  groupCreateStatus = 200;
  override?: (path: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;
  sequence = 0;
  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    const overridden = await this.override?.(path, init);
    if (overridden) return overridden;
    assert.ok(path.startsWith("/v8/management/"));
    const url = new URL(`https://home.example${path}`);
    const endpoint = url.pathname.slice("/v8/management".length);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Row : {};
    if (endpoint === "/oauth/auth-url") {
      const state = `state-${++this.sequence}`;
      this.sessions.set(state, { provider: url.searchParams.get("provider")!, status: "wait" });
      return Response.json({ status: "ok", state, url: this.url, flow: this.flow, meta: { user_code: "FAKE-CODE" } });
    }
    if (endpoint === "/oauth/callback") {
      const redirect = new URL(String(body.redirect_url));
      const state = redirect.searchParams.get("state")!;
      const session = this.sessions.get(state);
      if (!session) return Response.json({ status: "error" }, { status: 404 });
      if (session.status !== "wait") return Response.json({ status: "error" }, { status: 409 });
      if (!redirect.searchParams.get("code") && !redirect.searchParams.get("error")) return Response.json({ status: "error" }, { status: 400 });
      if (session.provider !== body.provider) return Response.json({ status: "error" }, { status: 400 });
      return Response.json({ status: "ok" });
    }
    if (endpoint === "/oauth/status") {
      assert.ok(url.searchParams.get("state"), "never poll without a backend state");
      const session = this.sessions.get(url.searchParams.get("state")!);
      return session ? Response.json(session) : Response.json({ status: "error", error: "unknown or expired state" });
    }
    if (endpoint === "/oauth/session") {
      assert.equal(method, "DELETE");
      const state = url.searchParams.get("state")!;
      const session = this.sessions.get(state);
      const cancelled = session?.status === "wait";
      if (cancelled) this.sessions.set(state, { ...session, status: "error" });
      return Response.json({ status: "ok", cancelled });
    }
    if (endpoint === "/credentials") {
      if (method === "POST") {
        if (typeof body.type !== "string" || !body.type) return Response.json({ error: "upload_failed" }, { status: 400 });
        if (body.uuid !== undefined && (typeof body.uuid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.uuid.trim()))) return Response.json({ error: "upload_failed" }, { status: 400 });
        const id = typeof body.uuid === "string" ? body.uuid.trim() : crypto.randomUUID();
        this.files.set(id, { ...body, uuid: id, id, provider: body.type });
        return Response.json({ status: "ok", name: `${id}.json` });
      }
      if (method === "DELETE") {
        return this.files.delete(url.searchParams.get("id")!) ? Response.json({ status: "ok" }) : Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ files: [...this.files.values()] });
    }
    if (endpoint === "/credentials/fields" && method === "PATCH") {
      const file = this.files.get(String(body.id));
      if (!file) return Response.json({}, { status: 404 });
      file.websockets = body.websockets;
      return Response.json({ status: "ok" });
    }
    if (endpoint === "/quota/credentials") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (limit < 1 || limit > 200) return Response.json({ error: "INVALID_PAGINATION" }, { status: 400 });
      const ids = new Set(url.searchParams.get("ids")?.split(",") ?? []);
      const quota = this.quota.filter((row) => !ids.size || ids.has(String(row.credential_id)));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return Response.json({ items: quota.slice(offset, offset + limit), total: quota.length, limit, offset });
    }
    if (endpoint.startsWith("/quota/credentials/")) {
      const id = decodeURIComponent(endpoint.slice("/quota/credentials/".length));
      const credential = this.quota.find((row) => row.credential_id === id) ?? { credential_id: id };
      return Response.json({ credential, windows: credential.primary_windows ?? [], reset_credits: null });
    }
    if (endpoint === "/usage/records") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      assert.ok(limit >= 1 && limit <= 200);
      const session = url.searchParams.get("session_id");
      const key = url.searchParams.get("client_key_id");
      const status = url.searchParams.get("status");
      const matches = this.usage.filter((row) => this.ignoreUsageFilters || ((!session || row.session_id === session)
        && (!key || (row.client as Row | undefined)?.api_key_id === Number(key))
        && (!status || row.status === status || (/^[1-5][0-9]{2}$/.test(status) && row.status_code === Number(status)))));
      return Response.json({ items: matches.slice(offset, offset + limit), total: matches.length, limit, offset, sort: "timestamp_desc" });
    }
    if (endpoint === "/credentials/quota/fetch") {
      assert.equal(method, "POST");
      return Response.json({ accepted: true, credential_id: body.auth_index }, { status: 202 });
    }
    if (endpoint === "/channel-groups") {
      if (method === "POST") {
        const group = { id: this.groups.length ? Math.max(...this.groups.map((group) => group.id)) + 10 : 20, channel_name: String(body.channel_name) };
        this.groups.push(group);
        if (this.duplicateCreate) this.groups.push({ ...group, id: 10 });
        return Response.json({ channel_group: group }, { status: this.groupCreateStatus });
      }
      return Response.json({ channel_groups: this.groups });
    }
    if (endpoint === "/channel-group-details") {
      if (method === "POST") {
        const member = { id: this.members.length + 1, channel_group_id: Number(body.channel_group_id), auth_id: String(body.auth_id) };
        this.members.push(member);
        return Response.json({ channel_group_detail: member });
      }
      return Response.json({ channel_group_details: this.members.filter((item) => !url.searchParams.has("channel_group_id") || item.channel_group_id === Number(url.searchParams.get("channel_group_id"))) });
    }
    if (endpoint.startsWith("/channel-group-details/") && method === "DELETE") {
      this.members = this.members.filter((item) => item.id !== Number(endpoint.split("/").at(-1)));
      return Response.json({ status: "ok" });
    }
    throw new Error(`Unexpected fake Home endpoint ${endpoint}`);
  };
  addFile(id: string, fileProvider = provider, extra: Row = {}) { this.files.set(id, { id, provider: fileProvider, ...extra }); }
  addGroup(pool: string, id: number, ids: string[]) {
    this.groups.push({ id, channel_name: `signalbox-pool-${pool}` });
    for (const auth_id of ids) this.members.push({ id: this.members.length + 1, channel_group_id: id, auth_id });
  }
}
function state(start: SignInStarted): string {
  return (JSON.parse(Buffer.from(start.session.split(".")[1]!, "base64url").toString()) as { state: string }).state;
}
interface Options { pool?: string; owner?: boolean; token?: string; body?: unknown; raw?: string; method?: string; signal?: AbortSignal }
async function fixture(audience: readonly string[] = []) {
  const home = new FakeHome();
  const storage = new MemoryStorage();
  const productEvents: [string, string][] = [];
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const deps = { signingKey, previousSigningKey: undefined as string | undefined, home: home.fetch, now: () => new Date(time), audience: async () => audience,
    onProductEvent: (event: string, accountId: string) => productEvents.push([event, accountId]) };
  let control = new PoolControl(storage, deps);
  const tokens = new Map<string, string>();
  async function request(path: string, options: Options = {}): Promise<Request> {
    const pool = options.pool ?? "pool-a";
    if (!tokens.has(pool)) tokens.set(pool, await signPoolToken(signingKey, { pool, owner: "fake-owner", organization: "fake-org" }));
    return new Request(`https://pool.example/pool/v1${path}`, {
      method: options.method ?? (options.body !== undefined || options.raw !== undefined ? "POST" : "GET"),
      signal: options.signal,
      headers: { Authorization: `Bearer ${options.token ?? tokens.get(pool)}`, "x-signalbox-caller": options.owner === false ? "fake-member" : "fake-owner" },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  }
  async function call(path: string, options: Options = {}) {
    const response = await control.handle(await request(path, options));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Type")!, /application\/json/);
    return response;
  }
  async function start(pool = "pool-a", id = provider) {
    const response = await call("/sign-ins", { pool, body: { provider: id } });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as SignInStarted;
  }
  async function callback(started: SignInStarted, pool = "pool-a") {
    return call("/sign-ins/callback", { pool, body: { session: started.session, redirectUrl: `http://localhost:1234/callback?state=${state(started)}&code=fake-code` } });
  }
  async function poll(started: SignInStarted, pool = "pool-a") {
    return call(`/sign-ins/status?session=${encodeURIComponent(started.session)}`, { pool });
  }
  async function acquire(action: string, input: Row = {}, operation = "native-operation") {
    const envelope = await signEnvelope(signingKey, accountAcquisitionPrefix, {
      owner: "organization:fake-org", provider, operation, action, at: time, expiresAt: time + 30_000, ...input,
    });
    return control.acquire(new Request(`https://pool.example${accountAcquisitionPath}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envelope }),
    }));
  }
  return { home, storage, deps, productEvents, request, call, start, callback, poll, acquire, advance: (ms: number) => { time += ms; }, expire: () => control.expire(), restart: () => { control = new PoolControl(storage, deps); } };
}
async function error(response: Response, code: string, status = 400) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json() as Row).error, code);
}
async function status(response: Response, expected: SignInStatus) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected); }

test("an account check forces a scoped Home collection and returns its completed reading", async () => {
  const f = await fixture();
  f.home.addFile("checked"); f.home.addGroup("pool-a", 10, ["checked"]);
  let collected = false;
  f.home.override = (path, init) => {
    if (path.endsWith("/quota/collect")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { credential_ids: ["checked"] });
      collected = true;
      return Response.json({ accepted: 1, running: true }, { status: 202 });
    }
    if (path.endsWith("/quota/credentials/checked")) return Response.json({
      credential: { credential_id: "checked" }, windows: [], reset_credits: null,
      collection: { status: collected ? "success" : "idle", freshness: collected ? "fresh" : "never",
        observed_at: collected ? f.deps.now().toISOString() : null,
        last_attempt_at: collected ? f.deps.now().toISOString() : null },
    });
    return undefined;
  };
  const response = await f.call("/accounts/checked/collect", { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json() as Row;
  assert.equal(value.id, "checked"); assert.equal(value.freshness, "fresh");
  assert.equal(collected, true);
  await error(await f.call("/accounts/other/collect", { method: "POST" }), "not_found", 404);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 1);
});

test("members may check only their current pool's accounts", async () => {
  const denied = await fixture();
  await error(await denied.call("/accounts/a/collect", { method: "POST", owner: false }), "not_owner", 403);
  assert.equal(denied.home.calls.length, 0);
  const f = await fixture(["fake-member"]);
  f.home.addFile("a"); f.home.addGroup("pool-a", 10, ["a"]);
  f.home.override = (path) => path.endsWith("/quota/credentials/a") ? Response.json({
    credential: { credential_id: "a" }, windows: [],
    collection: { status: "success", freshness: "fresh", observed_at: f.deps.now().toISOString() },
  }) : undefined;
  assert.equal((await f.call("/accounts/a/collect", { method: "POST", owner: false })).status, 200);
  await error(await f.call("/accounts/a/collect", { method: "POST", owner: false, pool: "pool-b" }), "not_found", 404);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 0);
});

test("a failed collection exposes only its known error code, with no diagnostic data", async () => {
  const f = await fixture();
  f.home.addFile("a"); f.home.addGroup("pool-a", 10, ["a"]);
  f.home.override = (path) => path.endsWith("/quota/credentials/a") ? Response.json({
    credential: { credential_id: "a" }, windows: [],
    collection: { status: "failed", freshness: "never", last_attempt_at: f.deps.now().toISOString(),
      error: { code: "UPSTREAM_AUTH_REJECTED", message: "private-provider-response", request_id: "private-id" } },
  }) : undefined;
  const response = await f.call("/accounts/a/collect", { method: "POST" });
  const body = await response.text();
  assert.equal(response.status, 200); assert.ok(!body.includes("private"));
  assert.deepEqual((JSON.parse(body) as Row).collection, { status: "failed", errorCode: "UPSTREAM_AUTH_REJECTED", lastAttemptAt: f.deps.now().toISOString() });
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 0);
});

for (const [name, blocked, upstream, expected] of [["refused refresh", true, 401, "unauthorized"],
  ["transient refresh", true, 503, "unavailable"], ["quota cooldown", false, 429, null]] as const) {
  test(`a fresh quota cannot hide a ${name}`, async () => {
    const f = await fixture();
    f.home.addFile("a"); f.home.addGroup("pool-a", 10, ["a"]);
    f.home.files.set("a", { ...f.home.files.get("a"), unavailable: true, status: blocked ? "error" : "active" });
    f.home.override = (path) => {
      if (path.endsWith("/quota/credentials/a")) return Response.json({ credential: { credential_id: "a" }, windows: [],
        collection: { status: "success", freshness: "fresh", observed_at: f.deps.now().toISOString() } });
      if (path.endsWith("/credentials/a/model-states")) return Response.json({ credential: { credential_id: "a", refresh_blocked: blocked,
        last_error: { upstream: { status: upstream, body: "private-provider-response" } } } });
      return undefined;
    };
    const response = await f.call("/accounts/a/collect", { method: "POST" });
    assert.equal(response.status, 200);
    const body = await response.text(); assert.ok(!body.includes("private"));
    assert.equal(subscriptionFailure(JSON.parse(body) as Account, f.deps.now().getTime()), expected);
  });
}

for (const step of ["membership", "credentials", "quota", "runtime"] as const) {
  test(`a canceled health check does not wait for hung Home ${step}`, async () => {
    const f = await fixture();
    f.home.addFile("a"); f.home.addGroup("pool-a", 10, ["a"]);
    if (step === "runtime") f.home.files.set("a", { ...f.home.files.get("a"), status: "error" });
    const entered = deferred<void>(), release = deferred<void>();
    const controller = new AbortController();
    f.home.override = async (path, init) => {
      const held = step === "membership" ? path.endsWith("/channel-groups") : step === "credentials" ? path.endsWith("/credentials")
        : step === "quota" ? path.endsWith("/quota/credentials/a") : path.endsWith("/model-states");
      if (held) {
        assert.ok(init?.signal, "every Home read gets the check's deadline");
        entered.resolve(); await release.promise;
      }
      if (path.endsWith("/quota/credentials/a")) return Response.json({ credential: { credential_id: "a" }, windows: [],
        collection: { status: "success", freshness: "fresh", observed_at: f.deps.now().toISOString() } });
      return undefined;
    };
    const checking = f.call("/accounts/a/collect", { method: "POST", signal: controller.signal });
    await entered.promise;
    controller.abort();
    try { await withoutWaitingForGate(checking); await error(await checking, "backend_unavailable", 503); }
    finally { release.resolve(); await checking; }
  });
}

test("invalid and absent pool tokens never contact Home", async () => {
  const f = await fixture();
  for (const token of ["fake-token", "sbp1.invalid.invalid", ""]) await error(await f.call("/pool", { token }), "unauthorized", 401);
  const response = await handleControl(new Request("https://pool.example/pool/v1/pool"), { ...f.deps, attribution: null });
  await error(response, "unauthorized", 401);
  assert.equal(f.home.calls.length, 0);
});

test("only GET pool is available to a non-owner; empty reads create nothing", async () => {
  const f = await fixture();
  const view = await (await f.call("/pool", { owner: false })).json() as PoolView;
  assert.deepEqual(view, { isOwner: false, providers, accounts: [] });
  for (const [path, method] of [["/sign-ins", "POST"], ["/sign-ins", "DELETE"], ["/sign-ins/status", "GET"], ["/sign-ins/callback", "POST"], ["/login-files", "POST"], ["/accounts/fake", "DELETE"]]) {
    await error(await f.call(path!, { method, owner: false }), "not_owner", 403);
  }
  assert.deepEqual(f.home.calls.map((call) => call.path), ["/v8/management/channel-groups", "/v8/management/credentials"]);
});

test("unknown routes and lookalike boundaries return not_found", async () => {
  const f = await fixture();
  for (const path of ["", "/", "/other", "/pool/", "/accounts/a/extra"]) await error(await f.call(path, { method: "DELETE" }), "not_found", 404);
  const response = await handleControl(new Request("https://pool.example/pool/v10/pool", { headers: (await f.request("/pool")).headers }), { ...f.deps, attribution: null });
  await error(response, "not_found", 404);
});

test("Kimi regional sign-ins and login files retain their provider identity", async () => {
  const f = await fixture();
  f.home.flow = "device";
  for (const id of ["kimi", "kimi-ai"]) {
    const started = await f.start("pool-a", id);
    const session = f.home.sessions.get(state(started))!;
    assert.equal(session.provider, id);
    f.home.addFile(`signed-in-${id}`, id);
    session.status = "ok";
    await status(await f.poll(started), { status: "connected", accountId: `signed-in-${id}` });
    const uploaded = await f.call("/login-files", { body: { type: id, access_token: "synthetic-token" } });
    assert.equal(uploaded.status, 200);
    const { accountId } = await uploaded.json() as { accountId: string };
    const view = await (await f.call("/pool")).json() as PoolView;
    assert.equal(view.accounts.find((account) => account.id === accountId)?.provider, id);
  }
});

test("unknown providers are rejected locally and Home 404 is mapped", async () => {
  const f = await fixture();
  await error(await f.call("/sign-ins", { body: { provider: "no-such-provider" } }), "unknown_provider");
  assert.equal(f.home.calls.length, 0);
  f.home.override = (path) => path.includes("/oauth/auth-url") ? Response.json({ error: "provider_not_found" }, { status: 404 }) : undefined;
  await error(await f.call("/sign-ins", { body: { provider } }), "unknown_provider");
  f.home.override = undefined;
  await f.start();
});

for (const [redirect, expected] of [["http://localhost:44/end", "callback"], ["http://127.0.0.1/end", "callback"], ["http://[::1]:44/end", "callback"], ["https://login.example/end", "device"], ["http://localhost.example/end", "device"], ["", "device"]] as const) {
  test(`flow is ${expected} for redirect_uri ${redirect || "absent"}`, async () => {
    const f = await fixture();
    f.home.url = `https://login.example/start${redirect ? `?redirect_uri=${encodeURIComponent(redirect)}` : ""}`;
    const started = await f.start();
    assert.equal(started.flow, expected);
    assert.equal(started.userCode, "FAKE-CODE");
    assert.equal(started.expiresAt, "2026-01-01T00:20:00.000Z");
    assert.notEqual(started.session, state(started));
  });
}
for (const [flow, expected] of [["device", "device"], ["browser", "callback"], ["callback", "callback"]] as const) {
  test(`explicit ${flow} flow overrides URL inference`, async () => {
    const f = await fixture(); f.home.flow = flow;
    f.home.url = "https://login.example/approve";
    assert.equal((await f.start()).flow, expected);
  });
}

test("sessions reject tampering, cross-pool use, malformed encoding and expiry", async () => {
  const f = await fixture(); const started = await f.start();
  const parts = started.session.split(".");
  parts[1] = Buffer.from(JSON.stringify({ pool: "pool-b" })).toString("base64url");
  for (const session of [parts.join("."), `${started.session}x`, "sbs1.!.!"]) await error(await f.call(`/sign-ins/status?session=${encodeURIComponent(session)}`), "invalid_session");
  await error(await f.poll(started, "pool-b"), "invalid_session");
  f.advance(20 * 60_000);
  await error(await f.poll(started), "invalid_session");
  assert.equal(f.home.calls.filter((call) => call.path.includes("/oauth/status")).length, 0);
});

test("callback must match the signed state and callback flow", async () => {
  const f = await fixture(); const started = await f.start();
  await error(await f.call("/sign-ins/callback", { body: { session: started.session, redirectUrl: "http://localhost/end?state=wrong&code=fake" } }), "invalid_callback");
  f.home.flow = "device"; const device = await f.start("pool-b", otherProvider);
  await error(await f.callback(device, "pool-b"), "invalid_callback");
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/oauth/callback")).length, 0);
});

test("waiting and failed statuses are translated without leaking backend errors", async () => {
  const f = await fixture(); const started = await f.start();
  await status(await f.poll(started), { status: "waiting" });
  await f.callback(started);
  f.home.sessions.get(state(started))!.status = "error";
  const response = await f.poll(started); const value = await response.json() as Row;
  assert.equal(value.status, "failed"); assert.match(String(value.message), /Sign-in failed/);
  assert.equal(f.home.members.length, 0);
});

test("future Home auth_ids and auth_id are added idempotently", async () => {
  const f = await fixture(); const started = await f.start();
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_ids: ["exact-b", "exact-a"], auth_id: "exact-a" });
  f.home.addFile("exact-a"); f.home.addFile("exact-b");
  await status(await f.poll(started), { status: "connected", accountId: "exact-b" });
  await status(await f.poll(started), { status: "connected", accountId: "exact-b" });
  assert.deepEqual(f.home.members.map((member) => member.auth_id).sort(), ["exact-a", "exact-b"]);
  // Each new account's usage is read once, when it joins the pool.
  const reads = f.home.calls.filter((call) => call.path === "/v8/management/credentials/quota/fetch");
  assert.deepEqual(reads.map((call) => JSON.parse(String(call.body)).auth_index).sort(), ["exact-a", "exact-b"]);
});

test("Codex sign-in retries its saved account after a failed WebSocket enablement", async () => {
  const f = await fixture();
  const started = await f.start("pool-a", "codex");
  await f.callback(started);
  f.home.addFile("codex-connected", "codex");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "codex-connected" });
  f.home.override = (path) => {
    if (!path.endsWith("/credentials/fields")) return undefined;
    // Home can persist the flag and fail ReloadAuths before it acknowledges the patch.
    f.home.files.get("codex-connected")!.websockets = true;
    return Response.json({}, { status: 503 });
  };
  await error(await f.poll(started), "backend_unavailable", 503);
  assert.equal(f.home.members.length, 0);
  f.restart();
  f.home.override = undefined;
  await status(await f.poll(started), { status: "connected", accountId: "codex-connected" });
  assert.equal(f.home.files.get("codex-connected")!.websockets, true);
  assert.equal(f.home.members.length, 1);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/credentials/fields")).length, 2);
});

test("terminal Codex enablement failure releases ids before any membership write", async () => {
  const f = await fixture();
  const started = await f.start("pool-a", "codex");
  await f.callback(started);
  f.home.addFile("codex-expired", "codex");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "codex-expired" });
  f.home.override = (path) => path.endsWith("/credentials/fields") ? Response.json({}, { status: 503 }) : undefined;
  await error(await f.poll(started), "backend_unavailable", 503);
  f.advance(12 * 60_000);
  await f.expire();
  f.restart();
  const saved = f.storage.values.get(attributionStorageKey) as { assigned: string[] };
  assert.deepEqual(saved.assigned, []);
  assert.equal(f.home.members.length, 0);
  f.home.override = undefined;
  const retried = await f.start("pool-a", "codex");
  Object.assign(f.home.sessions.get(state(retried))!, { status: "ok", auth_id: "codex-expired" });
  await status(await f.poll(retried), { status: "connected", accountId: "codex-expired" });
});

test("Codex login-file retry enables transport without uploading another credential", async () => {
  const f = await fixture();
  f.home.override = (path) => path.endsWith("/credentials/fields") ? Response.json({}, { status: 503 }) : undefined;
  const body = { type: "codex", access_token: "fixture-token", websockets: false };
  await error(await f.call("/login-files", { body }), "backend_unavailable", 503);
  assert.equal(f.home.files.size, 1);
  assert.equal(f.home.members.length, 0);
  f.restart();
  f.home.override = undefined;
  assert.equal((await f.call("/login-files", { body })).status, 200);
  assert.equal(f.home.files.size, 1);
  assert.equal([...f.home.files.values()][0]!.websockets, true);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/credentials") && call.method === "POST").length, 1);
});

test("a provider account connection emits durable pool and account events once for the signed caller", async () => {
  const f = await fixture();
  const started = await f.start();
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "connected-provider-account" });
  f.home.addFile("connected-provider-account");

  await status(await f.poll(started), { status: "connected", accountId: "connected-provider-account" });
  await status(await f.poll(started), { status: "connected", accountId: "connected-provider-account" });

  assert.deepEqual(f.productEvents, [["pool_created", "fake-owner"], ["account_connected", "fake-owner"]]);
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["connected-provider-account"]);
});

test("the alarm preserves the signed caller when it completes an unattended provider connection", async () => {
  const f = await fixture();
  f.home.flow = "device";
  const started = await f.start();
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "connected-provider-account" });

  f.advance(30_000);
  await f.expire();
  await f.expire();

  assert.deepEqual(f.productEvents, [["pool_created", "fake-owner"], ["account_connected", "fake-owner"]]);
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["connected-provider-account"]);
});

test("a failed usage read never fails the connect", async () => {
  const f = await fixture(); const started = await f.start();
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "exact-a" });
  f.home.addFile("exact-a");
  f.home.override = (path) => path === "/v8/management/credentials/quota/fetch" ? Promise.reject(new Error("down")) : undefined;
  await status(await f.poll(started), { status: "connected", accountId: "exact-a" });
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["exact-a"]);
});

test("two same-provider callbacks serialize across pools and each gets only its account", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.start(), f.start("pool-b")]);
  await status(await f.callback(first), { status: "waiting" });
  const secondCallback = f.callback(second, "pool-b");
  await new Promise((resolve) => setImmediate(resolve));
  f.home.addFile("account-a"); f.home.sessions.get(state(first))!.status = "ok";
  await status(await f.poll(first), { status: "connected", accountId: "account-a" });
  await status(await secondCallback, { status: "waiting" });
  f.home.addFile("account-b"); f.home.sessions.get(state(second))!.status = "ok";
  await status(await f.poll(second, "pool-b"), { status: "connected", accountId: "account-b" });
  for (const [pool, id] of [["pool-a", "account-a"], ["pool-b", "account-b"]]) {
    const view = await (await f.call("/pool", { pool })).json() as PoolView;
    assert.deepEqual(view.accounts.map((account) => account.id), [id]);
  }
});

test("different providers can exchange in parallel", async () => {
  const f = await fixture(); f.home.flow = "device";
  const [first, second] = await Promise.all([f.start(), f.start("pool-b", otherProvider)]);
  f.home.addFile("one", provider); f.home.addFile("two", otherProvider);
  f.home.sessions.get(state(first))!.status = "ok"; f.home.sessions.get(state(second))!.status = "ok";
  const results = await Promise.all([f.poll(first), f.poll(second, "pool-b")]);
  await status(results[0]!, { status: "connected", accountId: "one" });
  await status(results[1]!, { status: "connected", accountId: "two" });
});

for (const release of ["cancel", "expiry"] as const) {
  test(`device lock blocks a second pool and releases after ${release}`, async () => {
    const f = await fixture(); f.home.flow = "device";
    const first = await f.start();
    await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
    assert.equal(f.home.sessions.size, 1);
    if (release === "cancel") await f.call(`/sign-ins?session=${encodeURIComponent(first.session)}`, { method: "DELETE" });
    else { f.advance(16 * 60_000); await f.expire(); }
    assert.ok(f.home.calls.some((call) => call.method === "DELETE" && call.path.includes(`/oauth/session?state=${state(first)}`)));
    await f.start("pool-b");
  });
}

test("device sign-ins stay alive without polling through Home's 16 minute deadline and DO restart", async () => {
  const f = await fixture(); f.home.flow = "device";
  const started = await f.start();
  assert.equal(f.storage.alarm, Date.parse("2026-01-01T00:00:30.000Z"));
  f.advance(50_000); await f.poll(started); f.restart(); f.advance(20_000); await f.expire();
  assert.ok(f.home.sessions.has(state(started)));
  await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
  f.advance(40_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))?.status, "wait");
  assert.equal(f.home.calls.filter((call) => call.path.includes("/oauth/session?")).length, 0);
  f.advance(16 * 60_000 - 110_000); await f.expire();
  await f.start("pool-b");
});

test("an upload while a callback is pending is never attributed to that callback", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  const uploaded = await (await f.call("/login-files", { pool: "pool-b", body: { type: provider, refresh_token: "obviously-fake" } })).json() as { accountId: string };
  f.home.addFile("callback-account"); f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started), { status: "connected", accountId: "callback-account" });
  const view = await (await f.call("/pool", { pool: "pool-b" })).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => account.id), [uploaded.accountId]);
});

test("a completed sign-in without a new credential fails instead of claiming a re-sign", async () => {
  const f = await fixture(); f.home.addFile("existing");
  const started = await f.start(); await f.callback(started); f.home.sessions.get(state(started))!.status = "ok";
  assert.equal((await (await f.poll(started)).json() as SignInStatus).status, "failed");
  assert.equal(f.home.groups.length, 0);
});

test("ambiguous attribution fails closed and releases the provider lock", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.home.addFile("new-one"); f.home.addFile("new-two"); f.home.sessions.get(state(started))!.status = "ok";
  const value = await (await f.poll(started)).json() as Row;
  assert.equal(value.status, "failed"); assert.match(String(value.message), /More than one/);
  assert.equal(f.home.members.length, 0);
  f.home.flow = "device"; await f.start("pool-b");
});

test("ids in any pool group are excluded even if the DO assigned set predates them", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.home.addFile("already-owned"); f.home.addGroup("other-pool", 4, ["already-owned"]);
  f.home.addFile("ours"); f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started), { status: "connected", accountId: "ours" });
});

test("duplicate channel groups use the lowest id and all duplicate members are visible", async () => {
  const f = await fixture(); f.home.duplicateCreate = true; f.home.groupCreateStatus = 500;
  const started = await f.start(); Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "first" }); f.home.addFile("first");
  await status(await f.poll(started), { status: "connected", accountId: "first" });
  assert.equal(f.home.members[0]!.channel_group_id, 10);
  f.home.members.push({ id: 99, channel_group_id: 20, auth_id: "second" }); f.home.addFile("second");
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => account.id), ["first", "second"]);
});

test("pool view filters global credentials and quotas, sorts ids and normalizes usage", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["z", "a", "u", "e"]); f.home.addGroup("pool-b", 2, ["foreign"]);
  f.home.addFile("foreign"); f.home.addFile("z", "synthetic", { disabled: true, unavailable: true, status: "error", email: "fake@example.invalid" });
  f.home.addFile("a", provider, { unavailable: true }); f.home.addFile("u"); f.home.addFile("e", provider, { status: "error", status_message: "Needs sign-in" });
  f.home.quota = [{ credential_id: "z", plan: { name: "Example plan" }, observed_at: "2026-01-01T00:00:00Z", primary_windows: [
    { id: "high", label: "High", remaining_ratio: 2, reset_at: "2026-01-02T00:00:00Z", window_seconds: 3600 },
    { id: "low", label: "Low", used_ratio: 2 }, { id: "unknown", label: "Unknown" }, { id: "unlimited", label: "Unlimited", is_unlimited: true, remaining_ratio: 0, reset_at: "ignored" },
  ] }, { credential_id: "foreign", plan: { name: "Private" } }];
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => [account.id, account.state]), [["a", "unavailable"], ["e", "error"], ["u", "active"], ["z", "disabled"]]);
  assert.equal(view.accounts[3]!.plan, "Example plan"); assert.equal(view.accounts[3]!.label, "fake@example.invalid");
  assert.deepEqual(view.accounts[3]!.windows.map((window) => window.remainingRatio), [1, 0, null, 1]);
  assert.equal(view.accounts[3]!.windows[3]!.resetAt, null); assert.equal(view.accounts[0]!.observedAt, null);
  assert.ok(!f.home.calls.find((call) => call.path.includes("/quota/"))!.path.includes("foreign"));
});

test("delete refuses foreign ids and deletes every duplicate membership for owned ids", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["ours"]); f.home.addGroup("pool-a", 2, ["ours"]); f.home.addGroup("pool-b", 3, ["foreign"]);
  f.home.addFile("ours"); f.home.addFile("foreign");
  await error(await f.call("/accounts/foreign", { method: "DELETE" }), "not_found", 404);
  assert.equal((await f.call("/accounts/ours", { method: "DELETE" })).status, 200);
  assert.equal(f.home.files.has("ours"), false); assert.equal(f.home.files.has("foreign"), true);
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["foreign"]);
});

test("login file forwards sanitized JSON and rejects arrays, null, malformed, oversized and backend 400", async () => {
  const f = await fixture(); const raw = `{ "type" : ${JSON.stringify(provider)}, "refresh_token": "obviously-fake" }`;
  assert.equal((await f.call("/login-files", { raw })).status, 200);
  assert.deepEqual(JSON.parse(String(f.home.calls.find((call) => call.path.endsWith("/credentials") && call.method === "POST")!.body)), JSON.parse(raw));
  for (const input of ["[]", "null", "{", JSON.stringify({ padding: "x".repeat(1024 * 1024) })]) await error(await f.call("/login-files", { raw: input }), "invalid_login_file");
  f.home.override = (path, init) => path.endsWith("/credentials") && init?.method === "POST" ? Response.json({ error: "upload_failed" }, { status: 400 }) : undefined;
  await error(await f.call("/login-files", { body: { type: provider } }), "invalid_login_file");
});

for (const kind of ["network", "500", "401", "403", "malformed"] as const) {
  test(`backend ${kind} becomes a JSON 503 without retry or details`, async () => {
    const f = await fixture();
    f.home.override = () => { if (kind === "network") throw new Error("private diagnostic"); return new Response(kind === "malformed" ? "not JSON" : "private diagnostic", { status: kind === "malformed" ? 200 : Number(kind) }); };
    const response = await f.call("/pool");
    await error(response, "backend_unavailable", 503);
    assert.deepEqual(f.home.calls.map((call) => call.path), ["/v8/management/channel-groups", "/v8/management/credentials"]);
  });
}

test("future explicit ids cannot attach an account already owned by another pool", async () => {
  const f = await fixture(); f.home.addGroup("pool-b", 1, ["other-account"]); f.home.addFile("other-account");
  const started = await f.start();
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_ids: ["other-account"] });
  const value = await (await f.poll(started)).json() as Row;
  assert.equal(value.status, "failed"); assert.match(String(value.message), /already assigned/);
  assert.equal(f.home.groups.length, 1);
  assert.equal(f.home.members.length, 1);
});

for (const rejection of [400, 500, 503]) test(`a definite auth-url ${rejection} releases its pre-session reservation without retry`, async () => {
  const f = await fixture();
  f.home.override = (path) => path.includes("/oauth/auth-url") ? Response.json({ error: "rejected" }, { status: rejection }) : undefined;
  await error(await f.call("/sign-ins", { body: { provider } }), "backend_unavailable", 503);
  assert.equal(f.home.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
  f.home.override = undefined;
  await f.start();
});

test("an ambiguous auth-url failure keeps its reservation until the backend session can expire", async () => {
  const f = await fixture();
  f.home.override = (path) => { if (path.includes("/oauth/auth-url")) throw new Error("Ambiguous network failure"); return undefined; };
  await error(await f.call("/sign-ins", { body: { provider } }), "backend_unavailable", 503);
  f.home.override = undefined;
  await error(await f.call("/sign-ins", { body: { provider }, pool: "pool-b" }), "busy", 409);
  f.advance(20 * 60_000); await f.expire();
  await f.start("pool-b");
});

test("a busy callback waits at most ten seconds without blocking the active exchange", async (t) => {
  const f = await fixture(); const first = await f.start(); const second = await f.start("pool-b");
  await f.callback(first);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pending = f.callback(second, "pool-b");
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10_001);
  const response = await pending;
  await error(response, "busy", 409);
  assert.equal(response.headers.get("Retry-After"), "360");
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/oauth/callback")).length, 1);
});

test("a lost upload response cannot make a completed sign-in claim another pool's account", async () => {
  const f = await fixture(); f.home.addFile("existing");
  const started = await f.start(); await f.callback(started);
  f.home.override = (path, init) => {
    if (path.endsWith("/credentials") && init?.method === "POST") {
      f.home.addFile("unconfirmed-upload");
      return Response.json({ error: "lost_response" }, { status: 503 });
    }
    return undefined;
  };
  await error(await f.call("/login-files", { pool: "pool-b", body: { type: provider } }), "backend_unavailable", 503);
  f.home.override = undefined; f.restart();
  f.home.sessions.get(state(started))!.status = "ok";
  const result = await (await f.poll(started)).json() as Row;
  assert.equal(result.status, "failed"); assert.match(String(result.message), /upload could not be confirmed/);
  assert.equal(f.home.members.length, 0);
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function withoutWaitingForGate(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("request was blocked by unrelated work")), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

test("GET pool bypasses an in-flight attribution request and never loads its state", async () => {
  const f = await fixture();
  await f.call("/pool");
  assert.deepEqual(f.storage.readKeys, ["pool-account-removals:pool-a"]);
  const started = await f.start();
  const entered = deferred(); const release = deferred();
  f.home.override = async (path) => {
    if (path.includes("/oauth/status")) { entered.resolve(); await release.promise; }
    return undefined;
  };
  const poll = f.poll(started); await entered.promise;
  const before = { reads: f.storage.gets, writes: f.storage.puts, alarms: f.storage.alarmReads };
  let view: Response | undefined;
  const read = f.call("/pool", { pool: "pool-b" }).then((response) => { view = response; });
  try {
    await withoutWaitingForGate(read);
    assert.equal(view?.status, 200, "the view should finish while status is blocked");
    assert.deepEqual(f.storage.readKeys.slice(before.reads), ["pool-account-removals:pool-b"]);
    assert.equal(f.storage.puts, before.writes);
    assert.equal(f.storage.alarmReads, before.alarms);
  } finally { release.resolve(); await Promise.all([poll, read]); }
});

test("remove clears in-flight assignment ids and the same credential id can connect again", async () => {
  const f = await fixture();
  const first = await f.start();
  f.home.addFile("reusable"); Object.assign(f.home.sessions.get(state(first))!, { status: "ok", auth_id: "reusable" });
  await status(await f.poll(first), { status: "connected", accountId: "reusable" });
  assert.deepEqual((f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned, []);
  assert.equal(await (await f.call("/accounts/reusable", { method: "DELETE" })).json(), null);
  const second = await f.start(); await f.callback(second);
  f.home.addFile("reusable"); f.home.sessions.get(state(second))!.status = "ok";
  await status(await f.poll(second), { status: "connected", accountId: "reusable" });
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["reusable"]);
  assert.deepEqual((f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned, []);
});

test("cancel and remove both return JSON null", async () => {
  const f = await fixture(); const started = await f.start();
  assert.equal(await (await f.call(`/sign-ins?session=${encodeURIComponent(started.session)}`, { method: "DELETE" })).json(), null);
  f.home.addGroup("pool-a", 2, ["remove-me"]); f.home.addFile("remove-me");
  assert.equal(await (await f.call("/accounts/remove-me", { method: "DELETE" })).json(), null);
});

test("a busy callback enters the queue once while waiting for the provider release", async (t) => {
  const f = await fixture(); const first = await f.start(); const second = await f.start("pool-b");
  await f.callback(first);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const snapshots = f.home.calls.filter((call) => call.path.endsWith("/credentials")).length;
  const writes = f.storage.puts;
  const pending = f.callback(second, "pool-b");
  await nextTurn();
  for (let i = 0; i < 9; i++) { t.mock.timers.tick(1_000); await nextTurn(); }
  assert.equal(f.storage.puts, writes);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/credentials")).length, snapshots);
  // A request for another provider proceeds while the callback is asleep.
  await f.start("pool-c", otherProvider);
  t.mock.timers.tick(1_001);
  await error(await pending, "busy", 409);
});

for (const failure of ["network", "500", "401"] as const) {
  test(`expiry cleanup isolates ${failure} cancellation failures across providers`, async () => {
    const f = await fixture(); f.home.flow = "device";
    const first = await f.start(); const second = await f.start("pool-b", otherProvider);
    f.advance(16 * 60_000);
    f.home.override = (path) => {
      if (path.includes(`/oauth/session?state=${state(first)}`)) {
        if (failure === "network") throw new Error("fake cancellation outage");
        return Response.json({ error: "fake failure" }, { status: Number(failure) });
      }
      return undefined;
    };
    await f.expire();
    assert.ok(f.home.sessions.has(state(first)), "the failed cancellation keeps its stale lock");
    assert.equal(f.home.sessions.get(state(second))?.status, "error", "another provider is still cancelled");
    await f.start("pool-b", otherProvider);
    await error(await f.call("/sign-ins", { pool: "pool-c", body: { provider } }), "busy", 409);
    // Hard expiry releases even when cancelling the backend throws again.
    f.advance(20 * 60_000); await f.expire();
    await f.start();
    if (failure === "401") assert.equal(f.home.calls.filter((call) => call.path.includes(`/oauth/session?state=${state(first)}`)).length, 1);
  });
}

test("a login-file upload refuses an id already assigned to another pool", async () => {
  const f = await fixture(); f.home.addGroup("pool-b", 2, ["owned-elsewhere"]); f.home.addFile("owned-elsewhere");
  f.home.override = (path, init) => path.endsWith("/credentials") && init?.method === "POST"
    ? Response.json({ status: "ok", name: "owned-elsewhere.json" }) : undefined;
  await error(await f.call("/login-files", { body: { type: provider } }), "invalid_login_file");
  assert.equal(f.home.groups.length, 1);
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["owned-elsewhere"]);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/credentials/quota/fetch")).length, 0);
});

test("quota refresh runs after queue release and cannot hold another attribution request", async () => {
  const f = await fixture(); const started = await f.start();
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "new-account" });
  f.home.addFile("new-account");
  const entered = deferred(); const release = deferred();
  let writesAtRefresh = -1;
  f.home.override = async (path) => {
    if (path.endsWith("/credentials/quota/fetch")) { writesAtRefresh = f.storage.puts; entered.resolve(); await release.promise; }
    return undefined;
  };
  const connecting = f.poll(started); await entered.promise;
  let connected = false; void connecting.then(() => { connected = true; });
  let other = false;
  const another = f.start("pool-b", otherProvider).then(() => { other = true; });
  try {
    await withoutWaitingForGate(Promise.all([connecting, another]));
    assert.ok(connected, "quota completion must not gate the connect response");
    assert.ok(other, "quota completion must not gate another provider");
    assert.ok(writesAtRefresh > 0);
    const persisted = f.storage.values.get(attributionStorageKey) as { sessions: Record<string, { result?: SignInStatus }> };
    assert.deepEqual(persisted.sessions[state(started)]!.result, { status: "connected", accountId: "new-account" });
  } finally { release.resolve(); await Promise.all([connecting, another]); }
});

test("attribution loads once, throttles poll persistence, and keeps only provider snapshot ids", async () => {
  const f = await fixture(); f.home.flow = "device";
  f.home.addFile("same-provider"); f.home.addFile("unrelated-provider", otherProvider);
  const started = await f.start();
  const saved = f.storage.values.get(attributionStorageKey) as { locks: Record<string, { snapshot: string[] }> };
  assert.deepEqual(saved.locks[provider]!.snapshot, ["same-provider"]);
  const before = { gets: f.storage.gets, puts: f.storage.puts, alarms: f.storage.alarmReads };
  for (let i = 0; i < 10; i++) { f.advance(1_000); await f.poll(started); }
  assert.deepEqual({ gets: f.storage.gets, puts: f.storage.puts, alarms: f.storage.alarmReads }, before);
  f.advance(6_000); await f.poll(started);
  assert.equal(f.storage.puts, before.puts + 1);
  assert.equal(f.storage.gets, 1);
  assert.equal(f.storage.alarmReads, 1);
});

test("pool view starts credentials before membership finishes", async () => {
  const f = await fixture();
  f.home.addFile("a"); f.home.addGroup("pool-a", 10, ["a"]);
  const entered = deferred<void>(), release = deferred<void>(), credentials = deferred<void>();
  f.home.override = async (path) => {
    if (path.endsWith("/channel-groups")) { entered.resolve(); await release.promise; }
    if (path.endsWith("/credentials")) credentials.resolve();
    return undefined;
  };
  const reading = f.call("/pool");
  await entered.promise;
  try {
    await withoutWaitingForGate(credentials.promise);
    assert.ok(f.home.calls.some((call) => call.path.endsWith("/credentials")));
  } finally { release.resolve(); await reading; }
});

test("pool view reads credentials and quota concurrently and reuses cached channel groups", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["account"]); f.home.addFile("account");
  const entered = deferred(); const release = deferred();
  f.home.override = async (path) => {
    if (path.endsWith("/credentials")) { entered.resolve(); await release.promise; }
    return undefined;
  };
  const reading = f.call("/pool"); await entered.promise; await nextTurn();
  try { assert.ok(f.home.calls.some((call) => call.path.includes("/quota/credentials/"))); }
  finally { release.resolve(); await reading; }
  f.home.override = undefined;
  await f.call("/pool");
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/channel-groups")).length, 1);
  assert.equal(f.home.calls.filter((call) => call.path.includes("/quota/credentials/")).length, 1, "a second view reuses the cached detail read");
  // A deleted cached group is re-discovered after Home's 404.
  f.home.groups = [{ id: 4, channel_name: "signalbox-pool-pool-a" }];
  f.home.members = [{ id: 4, channel_group_id: 4, auth_id: "account" }];
  f.home.override = (path) => path.endsWith("/channel-group-details?channel_group_id=1") ? Response.json({ error: "not_found" }, { status: 404 }) : undefined;
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => account.id), ["account"]);
});

test("a missing quota detail leaves that account visible and a refresh drops its cached detail", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["missing", "refreshed"]);
  f.home.addFile("missing"); f.home.addFile("refreshed");
  f.home.override = (path) => path.endsWith("/quota/credentials/missing") ? Response.json({}, { status: 404 }) : undefined;
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => account.id), ["missing", "refreshed"]);
  assert.equal(view.accounts.find((account) => account.id === "missing")!.freshness, "never");
  const client = new HomeClient(f.home.fetch);
  const before = f.home.calls.filter((call) => call.path.endsWith("/quota/credentials/refreshed")).length;
  await client.quota(["refreshed"], true);
  await client.quota(["refreshed"], true);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/credentials/refreshed")).length, before + 1);
  await client.refreshQuota(["refreshed"]);
  await client.quota(["refreshed"], true);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/credentials/refreshed")).length, before + 2);
});

test("global ownership reads every membership in one call and reuses the snapshot for add", async () => {
  const f = await fixture();
  for (let i = 1; i <= 9; i++) f.home.addGroup(i === 1 ? "pool-a" : `other-${i}`, i, []);
  const started = await f.start(); f.home.addFile("new-account");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "new-account" });
  await status(await f.poll(started), { status: "connected", accountId: "new-account" });
  assert.equal(f.home.calls.filter((call) => call.path === "/v8/management/channel-group-details" && call.method === "GET").length, 1);
  assert.equal(f.home.calls.filter((call) => call.path.includes("/channel-group-details?")).length, 0);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/channel-groups")).length, 1);
});

test("an early shared alarm re-arms device status checks without cancelling an unpolled session", async () => {
  const f = await fixture(); f.home.flow = "device";
  const started = await f.start();
  f.advance(50_000); await f.poll(started);
  f.advance(10_000);
  // The warm-up lifecycle has replaced the fired alarm with its next five-minute alarm.
  f.storage.alarm = Date.parse("2026-01-01T00:06:00.000Z");
  await f.expire();
  assert.equal(f.storage.alarm, Date.parse("2026-01-01T00:01:20.000Z"));
  assert.ok(f.home.sessions.has(state(started)));
  f.advance(50_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))?.status, "wait");
  f.advance(16 * 60_000 - 110_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))?.status, "error");
});

test("legacy successful assignment markers do not block reconnecting a removed id", async () => {
  const f = await fixture();
  f.storage.values.set(attributionStorageKey, { locks: {}, sessions: {}, assigned: ["removed-before-upgrade"] });
  const started = await f.start();
  f.home.addFile("removed-before-upgrade");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "removed-before-upgrade" });
  await status(await f.poll(started), { status: "connected", accountId: "removed-before-upgrade" });
  assert.deepEqual((f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned, []);
});

test("legacy assignment migration preserves pending adds and active diffs", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.home.addFile("legacy-upload");
  f.home.addFile("pending-sign-in");
  const previous = structuredClone(f.storage.values.get(attributionStorageKey)) as {
    version?: number;
    locks: Record<string, { snapshot: string[] }>;
    sessions: Record<string, { session: Row; pendingIds?: string[] }>;
    assigned: string[];
  };
  delete previous.version;
  previous.assigned = ["legacy-upload", "pending-sign-in", "already-removed"];
  previous.sessions["another-pending-state"] = {
    session: { pool: "pool-b", provider: otherProvider, state: "another-pending-state", flow: "callback", expiresAt: started.expiresAt },
    pendingIds: ["pending-sign-in"],
  };
  f.storage.values.set(attributionStorageKey, previous); f.restart();
  // A completed session with no new credential must not take a legacy upload with no membership acknowledgement.
  f.home.sessions.get(state(started))!.status = "ok";
  assert.equal((await (await f.poll(started)).json() as SignInStatus).status, "failed");
  const current = f.storage.values.get(attributionStorageKey) as { version: number; assigned: string[] };
  assert.equal(current.version, 2);
  assert.deepEqual(current.assigned, ["pending-sign-in"]);
});

test("a failed credential delete preserves membership and retry authority", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["partial-remove"]); f.home.addFile("partial-remove");
  f.storage.values.set(attributionStorageKey, { version: 2, locks: {}, sessions: {}, assigned: ["partial-remove"] });
  f.home.override = (path, init) => path.includes("/credentials?id=") && init?.method === "DELETE"
    ? Response.json({ error: "fake delete failure" }, { status: 503 }) : undefined;
  await error(await f.call("/accounts/partial-remove", { method: "DELETE" }), "backend_unavailable", 503);
  assert.equal(f.home.members.length, 1);
  assert.equal(f.home.files.has("partial-remove"), true);
  assert.deepEqual((f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned, ["partial-remove"]);
  f.home.override = undefined;
  assert.equal((await f.call("/accounts/partial-remove", { method: "DELETE" })).status, 200);
  assert.equal(f.home.members.length, 0);
  assert.equal(f.home.files.has("partial-remove"), false);
  assert.deepEqual((f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned, []);
});

test("a failed credential deletion cannot expose the removed upload to an overlapping sign-in", async () => {
  const f = await fixture(); const started = await f.start("pool-b"); await f.callback(started, "pool-b");
  const uploaded = await (await f.call("/login-files", { body: { type: provider } })).json() as { accountId: string };
  f.home.override = (path, init) => path.includes("/credentials?id=") && init?.method === "DELETE"
    ? Response.json({ error: "fake delete failure" }, { status: 503 }) : undefined;
  await error(await f.call(`/accounts/${uploaded.accountId}`, { method: "DELETE" }), "backend_unavailable", 503);
  f.home.override = undefined;
  f.home.sessions.get(state(started))!.status = "ok";
  assert.equal((await (await f.poll(started, "pool-b")).json() as SignInStatus).status, "failed");
  assert.deepEqual(f.home.members.map((member) => member.auth_id), [uploaded.accountId]);
});

test("a pending sign-in cannot resurrect an account removed and reuploaded into another pool", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.home.addFile("moved-account");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "moved-account" });
  // Home commits membership but the response acknowledging it is lost.
  f.home.override = (path, init) => {
    if (path.endsWith("/channel-group-details") && init?.method === "POST") {
      const value = JSON.parse(String(init.body)) as Member;
      f.home.members.push({ id: 123, channel_group_id: value.channel_group_id, auth_id: value.auth_id });
      return Response.json({ error: "fake acknowledgement failure" }, { status: 503 });
    }
    return undefined;
  };
  await error(await f.poll(started), "backend_unavailable", 503);
  f.home.override = (path, init) => path.includes("/credentials?id=") && init?.method === "DELETE"
    ? Response.json({ error: "fake delete failure" }, { status: 503 }) : undefined;
  await error(await f.call("/accounts/moved-account", { method: "DELETE" }), "backend_unavailable", 503);
  f.home.override = undefined;
  assert.equal((await f.call("/accounts/moved-account", { method: "DELETE" })).status, 200);
  f.home.override = (path, init) => {
    if (path.endsWith("/credentials") && init?.method === "POST") {
      f.home.addFile("moved-account");
      return Response.json({ status: "ok", name: "moved-account.json" });
    }
    return undefined;
  };
  assert.equal((await f.call("/login-files", { pool: "pool-b", body: { type: provider } })).status, 200);
  f.restart();
  const result = await (await f.poll(started)).json() as SignInStatus;
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.message, /was removed/);
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.equal(view.accounts.length, 0);
  const other = await (await f.call("/pool", { pool: "pool-b" })).json() as PoolView;
  assert.deepEqual(other.accounts.map((account) => account.id), ["moved-account"]);
});

test("pending membership retries always recheck other pool ownership", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.home.addFile("pending-account");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "pending-account" });
  f.home.override = (path, init) => path.endsWith("/channel-group-details") && init?.method === "POST"
    ? Response.json({ error: "fake membership failure" }, { status: 503 }) : undefined;
  await error(await f.poll(started), "backend_unavailable", 503);
  f.home.override = undefined;
  // Simulate a management-side assignment while the first membership write is unresolved.
  f.home.addGroup("pool-b", 99, ["pending-account"]);
  const result = await (await f.poll(started)).json() as SignInStatus;
  assert.equal(result.status, "failed");
  assert.deepEqual(f.home.members.map((member) => member.channel_group_id), [99]);
});

test("login-file identity selectors cannot overwrite another pool's credential", async () => {
  const f = await fixture(); const victim = "11111111-2222-4333-8444-555555555555";
  f.home.addGroup("pool-b", 1, [victim]);
  f.home.addFile(victim, provider, { access_token: "obviously-fake-original", proxy_url: "https://original.example.invalid" });
  const before = structuredClone(f.home.files.get(victim));
  const response = await f.call("/login-files", { body: {
    type: provider, uuid: victim, id: victim, auth_index: victim,
    access_token: "obviously-fake-replacement", proxy_url: "https://replacement.example.invalid",
  } });
  assert.equal(response.status, 200);
  const added = await response.json() as { accountId: string };
  assert.notEqual(added.accountId, victim);
  assert.match(added.accountId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.home.files.get(victim), before);
  const forwarded = JSON.parse(String(f.home.calls.find((call) => call.path.endsWith("/credentials") && call.method === "POST")!.body)) as Row;
  for (const selector of ["uuid", "id", "auth_index"]) assert.ok(!Object.hasOwn(forwarded, selector));
  assert.equal(forwarded.access_token, "obviously-fake-replacement");
  const view = await (await f.call("/pool", { pool: "pool-b" })).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => account.id), [victim]);
});

test("FakeHome models Home's uuid replacement behavior directly", async () => {
  const home = new FakeHome(); const victim = "11111111-2222-4333-8444-555555555555";
  home.addFile(victim, provider, { access_token: "obviously-fake-original" });
  const response = await home.fetch("/v8/management/credentials", {
    method: "POST", body: JSON.stringify({ uuid: victim, type: provider, access_token: "obviously-fake-replacement" }),
  });
  assert.deepEqual(await response.json(), { status: "ok", name: `${victim}.json` });
  assert.equal(home.files.get(victim)!.access_token, "obviously-fake-replacement");
});

test("uploads accept every pinned sign-in type and reject other types before forwarding", async () => {
  const f = await fixture();
  for (const { id } of providers) assert.equal((await f.call("/login-files", { body: { type: id, access_token: "obviously-fake" } })).status, 200);
  const forwarded = f.home.calls.filter((call) => call.path.endsWith("/credentials") && call.method === "POST").length;
  for (const type of ["unsupported-type", "", null, 12, [], {}]) await error(await f.call("/login-files", { body: { type } }), "invalid_login_file");
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/credentials") && call.method === "POST").length, forwarded);
});

for (const flow of ["callback", "device"] as const) {
  test(`closing a completed ${flow} sign-in still attributes its account`, async () => {
    const f = await fixture(); f.home.flow = flow;
    const started = await f.start(); if (flow === "callback") await f.callback(started);
    f.home.addFile("completed-account"); f.home.sessions.get(state(started))!.status = "ok";
    const response = await f.call(`/sign-ins?session=${encodeURIComponent(started.session)}`, { method: "DELETE" });
    assert.equal(response.status, 200); assert.equal(await response.json(), null);
    await status(await f.poll(started), { status: "connected", accountId: "completed-account" });
    assert.deepEqual(f.home.members.map((member) => member.auth_id), ["completed-account"]);
  });
  test(`the alarm attributes an unattended completed ${flow} before Home forgets its status`, async () => {
    const f = await fixture(); f.home.flow = flow;
    const started = await f.start(); if (flow === "callback") await f.callback(started);
    f.home.addFile("completed-without-poll"); f.home.sessions.get(state(started))!.status = "ok";
    f.advance(30_000); await f.expire();
    assert.deepEqual(f.home.members.map((member) => member.auth_id), ["completed-without-poll"]);
    await status(await f.poll(started), { status: "connected", accountId: "completed-without-poll" });
    await f.start("pool-b");
  });
}

test("completion racing the stale-session cancellation is attributed before unlocking", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.home.override = (path) => {
    if (path.includes(`/oauth/session?state=${state(started)}`)) {
      f.home.sessions.get(state(started))!.status = "ok"; f.home.addFile("racing-completion");
    }
    return undefined;
  };
  f.advance(6 * 60_000); await f.expire();
  await status(await f.poll(started), { status: "connected", accountId: "racing-completion" });
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["racing-completion"]);
});

test("an unattended pasted callback waits six minutes before final cancellation and release", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.advance(60_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))!.status, "wait");
  f.advance(5 * 60_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))!.status, "error");
  const value = await (await f.poll(started)).json() as SignInStatus;
  assert.equal(value.status, "failed");
  await f.start("pool-b");
});

test("a Home callback 400 releases the lock and allows the same session to be pasted again", async () => {
  const f = await fixture(); const started = await f.start();
  const malformed = await f.call("/sign-ins/callback", { body: { session: started.session, redirectUrl: `http://localhost/end?state=${state(started)}` } });
  await error(malformed, "invalid_callback");
  assert.equal(f.home.sessions.get(state(started))!.status, "wait");
  const other = await f.start("pool-b"); await f.callback(other, "pool-b");
  await f.call(`/sign-ins?session=${encodeURIComponent(other.session)}`, { pool: "pool-b", method: "DELETE" });
  await status(await f.callback(started), { status: "waiting" });
  f.home.addFile("corrected-callback"); f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started), { status: "connected", accountId: "corrected-callback" });
});

for (const code of [404, 409]) {
  test(`a Home callback ${code} ends the local sign-in`, async () => {
    const f = await fixture(); const started = await f.start();
    f.home.override = (path) => path.endsWith("/oauth/callback") ? Response.json({ status: "error" }, { status: code }) : undefined;
    if (code === 409) f.home.sessions.get(state(started))!.status = "error";
    await error(await f.callback(started), "invalid_callback");
    f.home.override = undefined;
    await error(await f.callback(started), "invalid_session");
  });
}

test("unauthorized and non-owner requests bypass a blocked global attribution queue", async () => {
  const f = await fixture(); const started = await f.start();
  const entered = deferred(); const release = deferred();
  f.home.override = async (path) => {
    if (path.includes("/oauth/status")) { entered.resolve(); await release.promise; }
    return undefined;
  };
  const pending = f.poll(started); await entered.promise;
  const before = { gets: f.storage.gets, puts: f.storage.puts, calls: f.home.calls.length };
  try {
    await withoutWaitingForGate(Promise.all([
      f.call("/sign-ins", { token: "obviously-invalid", body: { provider } }).then((response) => error(response, "unauthorized", 401)),
      f.call("/sign-ins", { owner: false, body: { provider } }).then((response) => error(response, "not_owner", 403)),
    ]));
    assert.deepEqual({ gets: f.storage.gets, puts: f.storage.puts, calls: f.home.calls.length }, before);
  } finally { release.resolve(); await pending; }
});

for (const count of [75, 205]) {
  test(`pool view reads all ${count} details; sampler lists stay within Home's 200-item limit`, async () => {
    const f = await fixture(); const ids = Array.from({ length: count }, (_, i) => `account-${String(i).padStart(3, "0")}`);
    f.home.addGroup("pool-a", 1, ids);
    for (const id of ids) {
      f.home.addFile(id); f.home.quota.push({ credential_id: id, plan: { name: `plan-${id}` }, primary_windows: [{ id: "usage", scope: "account", window_seconds: 604800, remaining_ratio: 0.5 }] });
    }
    const view = await (await f.call("/pool")).json() as PoolView;
    assert.equal(view.accounts.length, count);
    for (const account of view.accounts) { assert.equal(account.plan, `plan-${account.id}`); assert.equal(account.windows.length, 1); }
    assert.equal(f.home.calls.filter((call) => call.path.includes("/quota/credentials/")).length, count);
    assert.equal((await new HomeClient(f.home.fetch).quota(ids)).length, count);
    const calls = f.home.calls.filter((call) => call.path.includes("/quota/credentials?"));
    assert.equal(calls.length, Math.ceil(count / 200));
    for (const call of calls) {
      const query = new URL(`https://home.example${call.path}`).searchParams;
      assert.equal(Number(query.get("limit")), query.get("ids")!.split(",").length);
      assert.ok(Number(query.get("limit")) <= 200);
    }
  });
}

test("an unknown backend state is HTTP 200 error and releases a device provider lock", async () => {
  const f = await fixture(); f.home.flow = "device";
  const started = await f.start(); f.home.sessions.delete(state(started));
  const backend = await f.home.fetch(`/v8/management/oauth/status?state=${state(started)}`);
  assert.equal(backend.status, 200); assert.equal((await backend.json() as Row).status, "error");
  const result = await (await f.poll(started)).json() as SignInStatus;
  assert.equal(result.status, "failed");
  await f.start("pool-b");
});

test("an accepted callback retry cannot unlock an exchange that is already running", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  const posts = f.home.calls.filter((call) => call.path.endsWith("/oauth/callback")).length;
  const repeated = await f.call("/sign-ins/callback", { body: { session: started.session, redirectUrl: `http://localhost/end?state=${state(started)}` } });
  await status(repeated, { status: "waiting" });
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/oauth/callback")).length, posts);
  await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
  f.home.addFile("original-exchange"); f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started), { status: "connected", accountId: "original-exchange" });
});

test("a completion just before the signed session expires is attributed by expiry cleanup", async () => {
  const f = await fixture(); f.home.flow = "device";
  const started = await f.start(); f.advance(20 * 60_000 - 1_000);
  f.home.addFile("just-completed"); f.home.sessions.get(state(started))!.status = "ok";
  f.advance(1_000); await f.expire();
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["just-completed"]);
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => account.id), ["just-completed"]);
  assert.ok(f.home.calls.some((call) => call.path.endsWith("/credentials/quota/fetch")));
});

test("a pending membership write can finish after Home forgets the completed session", async () => {
  const f = await fixture(); const started = await f.start(); await f.callback(started);
  f.home.addFile("pending-membership"); f.home.sessions.get(state(started))!.status = "ok";
  f.home.override = (path, init) => path.endsWith("/channel-group-details") && init?.method === "POST"
    ? Response.json({ error: "temporary membership outage" }, { status: 503 }) : undefined;
  await error(await f.poll(started), "backend_unavailable", 503);
  f.home.override = undefined; f.home.sessions.delete(state(started)); f.restart();
  await status(await f.poll(started), { status: "connected", accountId: "pending-membership" });
});


test("an unpolled device result survives Home's completed record and DO restart", async () => {
  const f = await fixture(); f.home.flow = "device";
  const started = await f.start();
  f.advance(2 * 60_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))?.status, "wait");
  f.advance(8 * 60_000);
  f.home.addFile("late-device-account"); f.home.sessions.get(state(started))!.status = "ok";
  await f.expire();
  f.home.sessions.delete(state(started)); f.restart(); f.advance(2 * 60_000);
  await status(await f.poll(started), { status: "connected", accountId: "late-device-account" });
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["late-device-account"]);
  await f.start("pool-b");
});

for (const failure of ["500", "network"] as const) {
  test(`a callback ${failure} resend preserves its snapshot and renews both deadlines`, async () => {
    const f = await fixture(); const started = await f.start();
    f.home.override = (path) => {
      if (!path.endsWith("/oauth/callback")) return undefined;
      if (failure === "network") throw new Error("fake lost callback response");
      return Response.json({ error: "fake callback failure" }, { status: 500 });
    };
    await error(await f.callback(started), "backend_unavailable", 503);
    const before = structuredClone(f.storage.values.get(attributionStorageKey)) as { locks: Record<string, { expires: number; hardExpires: number; snapshot: string[] }> };
    f.home.addFile("exchange-account"); f.advance(60_000); f.home.override = undefined;
    await status(await f.callback(started), { status: "waiting" });
    const after = f.storage.values.get(attributionStorageKey) as typeof before;
    assert.equal(after.locks[provider]!.expires, before.locks[provider]!.expires + 60_000);
    assert.equal(after.locks[provider]!.hardExpires, before.locks[provider]!.hardExpires + 60_000);
    assert.deepEqual(after.locks[provider]!.snapshot, before.locks[provider]!.snapshot);
    assert.equal(f.home.calls.filter((call) => call.path.endsWith("/oauth/callback")).length, 2);
    await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
    f.home.sessions.get(state(started))!.status = "ok";
    await status(await f.poll(started), { status: "connected", accountId: "exchange-account" });
  });
}

test("callback deadline starts when pasted and fails clearly while the result stays readable", async () => {
  const f = await fixture(); const started = await f.start();
  f.advance(4 * 60_000); await f.callback(started);
  f.advance(5 * 60_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))?.status, "wait");
  f.advance(60_000); await f.expire(); f.restart();
  const result = await (await f.poll(started)).json() as SignInStatus;
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.message, /timed out/);
  await f.start("pool-b");
});

for (const final of ["completed", "ceiling"] as const) {
  test(`an expired callback retains its lock through outage until ${final}`, async () => {
    const f = await fixture(); const started = await f.start(); await f.callback(started);
    f.home.override = (path) => { if (path.includes("/oauth/status?")) throw new Error("fake Home outage"); return undefined; };
    f.advance(6 * 60_000); await f.expire(); f.restart();
    await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
    f.advance(4 * 60_000); await f.expire();
    await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
    if (final === "completed") {
      f.home.override = undefined;
      f.home.addFile("recovered-callback"); f.home.sessions.get(state(started))!.status = "ok";
      f.advance(30_000); await f.expire();
      await status(await f.poll(started), { status: "connected", accountId: "recovered-callback" });
    } else {
      f.advance(60_000); await f.expire();
      f.home.override = undefined;
      const result = await (await f.poll(started)).json() as SignInStatus;
      assert.equal(result.status, "failed");
    }
    await f.start("pool-b");
  });
}

test("a credential already deleted is harmless on retry after membership cleanup fails", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["delete-retry"]); f.home.addFile("delete-retry");
  f.home.override = (path, init) => path.includes("/channel-group-details/") && init?.method === "DELETE"
    ? Response.json({ error: "fake membership outage" }, { status: 503 }) : undefined;
  await error(await f.call("/accounts/delete-retry", { method: "DELETE" }), "backend_unavailable", 503);
  assert.equal(f.home.files.has("delete-retry"), false); assert.equal(f.home.members.length, 1);
  const mutations = f.home.calls.filter((call) => call.method === "DELETE");
  assert.match(mutations[0]!.path, /credentials\?id=/);
  f.home.override = undefined; f.restart();
  assert.equal((await f.call("/accounts/delete-retry", { method: "DELETE" })).status, 200);
  assert.equal(f.home.members.length, 0);
});

for (const committed of [false, true]) {
  test(`a failed upload membership write retries its saved id after restart, committed=${committed}`, async () => {
    const f = await fixture(); const payload = { type: provider, refresh_token: "obviously-fake-retry-token" };
    f.home.override = (path, init) => {
      if (path.endsWith("/channel-group-details") && init?.method === "POST") {
        if (committed) {
          const member = JSON.parse(String(init.body)) as Member;
          f.home.members.push({ ...member, id: 100 });
        }
        return Response.json({ error: "fake lost membership acknowledgement" }, { status: 503 });
      }
      return undefined;
    };
    await error(await f.call("/login-files", { body: payload }), "backend_unavailable", 503);
    const id = [...f.home.files.keys()][0]!;
    assert.equal(f.home.files.size, 1);
    const saved = JSON.stringify(f.storage.values.get(attributionStorageKey));
    assert.equal(saved.includes(payload.refresh_token), false, "pending retries persist no login-file secrets");
    f.restart(); f.home.override = undefined;
    const retry = await f.call("/login-files", { body: { refresh_token: payload.refresh_token, type: payload.type } });
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.deepEqual(await retry.json(), { accountId: id });
    assert.equal(f.home.calls.filter((call) => call.path.endsWith("/credentials") && call.method === "POST").length, 1);
    assert.deepEqual(f.home.members.map((member) => member.auth_id), [id]);
    assert.deepEqual((f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned, []);
  });
}

for (const flow of ["device", "callback"] as const) {
  test(`a pool replaces its ${flow} sign-in and stores at most one session`, async () => {
    const f = await fixture(); f.home.flow = flow;
    const first = await f.start(); if (flow === "callback") await f.callback(first);
    for (let i = 0; i < 12; i++) await f.start();
    const saved = f.storage.values.get(attributionStorageKey) as { sessions: Record<string, unknown>; locks: Record<string, { pool: string }> };
    assert.equal(Object.keys(saved.sessions).length, 1);
    assert.ok(Object.values(saved.locks).length <= 1);
    assert.equal(f.home.sessions.get(state(first))?.status, "error");
    await error(await f.poll(first), "invalid_session");
  });
}

test("pool tokens and signed sessions survive signing key rotation", async () => {
  const f = await fixture(); const started = await f.start();
  f.deps.signingKey = "cd".repeat(32); f.deps.previousSigningKey = signingKey; f.restart();
  await status(await f.callback(started), { status: "waiting" });
  f.home.addFile("rotation-account"); f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started), { status: "connected", accountId: "rotation-account" });
  assert.equal((await f.call("/pool")).status, 200);
  f.deps.previousSigningKey = undefined; f.restart();
  await error(await f.call("/pool"), "unauthorized", 401);
});


for (const flow of ["device", "callback"] as const) {
  test(`a busy replacement provider preserves the pool's open ${flow} sign-in`, async () => {
    const f = await fixture(); f.home.flow = "device";
    await f.start("pool-b", otherProvider);
    f.home.flow = flow;
    const original = await f.start(); if (flow === "callback") await f.callback(original);
    const before = structuredClone(f.storage.values.get(attributionStorageKey));
    const cancelled = f.home.calls.filter((call) => call.method === "DELETE").length;
    await error(await f.call("/sign-ins", { body: { provider: otherProvider } }), "busy", 409);
    assert.deepEqual(f.storage.values.get(attributionStorageKey), before);
    assert.equal(f.home.calls.filter((call) => call.method === "DELETE").length, cancelled);
    await status(await f.poll(original), { status: "waiting" });
    f.home.addFile("preserved-account"); f.home.sessions.get(state(original))!.status = "ok";
    await status(await f.poll(original), { status: "connected", accountId: "preserved-account" });
  });
}

for (const [elapsed, minutes] of [[0, 16], [4 * 60_000 + 1, 12], [15 * 60_000 + 1, 1]] as const) {
  test(`busy reports ${minutes} remaining minutes after ${elapsed}ms and matches Retry-After`, async () => {
    const f = await fixture(); f.home.flow = "device"; await f.start();
    f.advance(elapsed);
    const response = await f.call("/sign-ins", { pool: "pool-b", body: { provider } });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("Retry-After"), String(minutes * 60));
    assert.deepEqual(await response.json(), {
      error: "busy",
      message: `Someone is connecting a ${providers[0]!.name} account right now. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
    });
  });
}

test("an expired ambiguous callback cannot be resent while final status is unreachable", async () => {
  const f = await fixture(); const started = await f.start();
  f.home.override = (path) => path.endsWith("/oauth/callback") ? Response.json({ error: "fake failure" }, { status: 500 }) : undefined;
  await error(await f.callback(started), "backend_unavailable", 503);
  const before = structuredClone(f.storage.values.get(attributionStorageKey)) as { locks: Record<string, { expires: number; hardExpires: number }> };
  f.advance(6 * 60_000);
  f.home.override = (path) => { if (path.includes("/oauth/status?")) throw new Error("fake status outage"); return undefined; };
  const response = await f.callback(started);
  assert.equal(response.status, 400);
  const value = await response.json() as Row;
  assert.equal(value.error, "invalid_session"); assert.match(String(value.message), /expired.*Start again/);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/oauth/callback")).length, 1);
  const after = f.storage.values.get(attributionStorageKey) as typeof before;
  assert.equal(after.locks[provider]!.expires, before.locks[provider]!.expires);
  assert.equal(after.locks[provider]!.hardExpires, before.locks[provider]!.hardExpires);
  await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
});

test("a late allowed callback resend keeps the lock until its new exchange finishes", async () => {
  const f = await fixture(); const started = await f.start();
  f.home.override = (path) => path.endsWith("/oauth/callback") ? Response.json({ error: "fake failure" }, { status: 500 }) : undefined;
  await error(await f.callback(started), "backend_unavailable", 503);
  f.advance(5 * 60_000 + 30_000); f.home.override = undefined;
  await status(await f.callback(started), { status: "waiting" }); f.restart();
  f.advance(60_000); await f.expire();
  assert.equal(f.home.sessions.get(state(started))?.status, "wait");
  await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
  f.advance(4 * 60_000);
  f.home.addFile("resent-callback-account"); f.home.sessions.get(state(started))!.status = "ok";
  await f.expire();
  await status(await f.poll(started), { status: "connected", accountId: "resent-callback-account" });
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["resent-callback-account"]);
});


function usageRow(id: string, account: string, session = "b2dff7a4-658d-811d-ab12-7d8bbe4e6157", key = 17, status = "success"): Row {
  return {
    id, usage_id: Number(id), credential: { credential_id: account, auth_index: "different-index", api_key_preview: "obviously-fake-provider-key" },
    session_id: session, parent_session_id: "header:fake-parent", root_session_id: "header:fake-root", status,
    timestamp: "2026-01-01T00:00:00.123456Z", request_id: `fake-request-${id}`,
    client: { api_key_id: key, api_key_masked: "obviously-fake-client-secret", username: "fake-person" },
    tokens: { total_tokens: 123 }, billing: { amount: 1 }, runtime: { home_ip: "192.0.2.1" },
  };
}

test("owner usage returns only exact-session pool records and only four public fields", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]); f.home.addGroup("pool-b", 2, ["other-account"]);
  f.home.addFile("own-account"); f.home.addFile("other-account");
  f.home.usage = [usageRow("101", "own-account"), usageRow("102", "other-account"), usageRow("103", "own-account")];
  const response = await f.call("/usage?session=fake-run");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { records: [
    { id: "101", account: "own-account", status: "success", at: "2026-01-01T00:00:00.123456Z" },
    { id: "103", account: "own-account", status: "success", at: "2026-01-01T00:00:00.123456Z" },
  ] });
  assert.equal(f.storage.gets, 0, "usage does not load control storage");
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.equal(view.accounts[0]!.id, "own-account");
  const call = f.home.calls.find((call) => call.path.includes("/usage/records?"))!;
  const query = new URL(`https://home.example${call.path}`).searchParams;
  assert.equal(query.get("session_id"), "b2dff7a4-658d-811d-ab12-7d8bbe4e6157"); assert.equal(query.get("limit"), "200");
  assert.equal(query.has("parent_session_id"), false); assert.equal(query.has("root_session_id"), false);
  assert.deepEqual(f.storage.readKeys, ["pool-account-removals:pool-a"]); assert.equal(f.storage.puts, 0);
});

test("usage rejects non-owners and invalid tokens before Home or attribution storage", async () => {
  const f = await fixture();
  await error(await f.call("/usage?key=17", { owner: false }), "not_owner", 403);
  await error(await f.call("/usage?session=fake-run", { token: "obviously-invalid" }), "unauthorized", 401);
  assert.equal(f.home.calls.length, 0); assert.equal(f.storage.gets, 0);
});

test("usage for a missing session or an empty pool returns an empty list", async () => {
  const f = await fixture();
  assert.deepEqual(await (await f.call("/usage?session=fake-run")).json(), { records: [] });
  assert.equal(f.home.calls.some((call) => call.path.includes("/usage/records?")), false);
  f.home.addGroup("pool-a", 1, ["own-account"]); f.restart();
  f.home.usage = [usageRow("101", "own-account")];
  assert.deepEqual(await (await f.call("/usage?session=no-such-run")).json(), { records: [] });
});

test("usage accepts only the node's canonical session, excluding raw, child and parent sessions", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]); f.home.ignoreUsageFilters = true;
  f.home.usage = [
    usageRow("99", "own-account", "header:fake-run"), usageRow("100", "own-account", "fake-run"),
    usageRow("101", "own-account", "header:fake-run:child"),
    usageRow("102", "own-account", "header:fake-parent"), usageRow("103", "own-account", "header:fake-root"),
    usageRow("104", "own-account", "00000000-0000-8000-8000-000000000001"), usageRow("105", "own-account"),
  ];
  const response = await f.call("/usage?session=fake-run&limit=1&parent_session_id=ignored&root_session_id=ignored");
  assert.equal(response.status, 200);
  const value = await response.json() as { records: { id: string }[] };
  assert.deepEqual(value.records.map((row) => row.id), ["105"]);
  assert.equal(f.home.calls.filter((call) => call.path.includes("/usage/records?")).length, 1);
  for (const call of f.home.calls.filter((call) => call.path.includes("/usage/records?"))) {
    const query = new URL(`https://home.example${call.path}`).searchParams;
    assert.equal(query.has("parent_session_id"), false); assert.equal(query.has("root_session_id"), false);
  }
});

for (const [suffix, count] of [["", 20], ["&limit=3", 3], ["&limit=999", 200]] as const) {
  test(`usage respects its default and capped limit for ${suffix || "the default"}`, async () => {
    const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.usage = Array.from({ length: 220 }, (_, i) => usageRow(String(i + 1), "own-account"));
    const response = await f.call(`/usage?session=fake-run${suffix}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { records: unknown[] }).records.length, count);
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    assert.equal(new URL(`https://home.example${path}`).searchParams.get("limit"), "200");
  });
}

test("usage passes status to Home and excludes other outcomes before applying its limit", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]); f.home.ignoreUsageFilters = true;
  f.home.usage = [usageRow("101", "own-account", "b2dff7a4-658d-811d-ab12-7d8bbe4e6157", 17, "failed"), usageRow("102", "own-account"), usageRow("103", "own-account")];
  const response = await f.call("/usage?session=fake-run&limit=1&status=success");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { records: { id: string }[] }).records.map((row) => row.id), ["102"]);
  for (const call of f.home.calls.filter((call) => call.path.includes("/usage/records?"))) {
    assert.equal(new URL(`https://home.example${call.path}`).searchParams.get("status"), "success");
  }
});

for (const [query, expected] of [["key=17", ["101", "102"]], ["session=fake-run&key=17", ["101"]], ["key=18", []]] as const) {
  test(`usage key filter ${query} is exact and remains scoped to the pool`, async () => {
    const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]); f.home.addGroup("pool-b", 2, ["other-account"]);
    f.home.usage = [usageRow("101", "own-account"), usageRow("102", "own-account", "header:another-run"), usageRow("103", "other-account", "b2dff7a4-658d-811d-ab12-7d8bbe4e6157", 18)];
    const response = await f.call(`/usage?${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { records: { id: string }[] }).records.map((row) => row.id), expected);
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    const params = new URL(`https://home.example${path}`).searchParams;
    assert.equal(params.get("client_key_id"), query.endsWith("18") ? "18" : "17");
    assert.equal(params.has("client_key"), false);
    assert.equal(params.has("session_id"), query.includes("session="));
  });
}

test("usage checks the numeric client key id again when Home returns wider results", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]); f.home.ignoreUsageFilters = true;
  f.home.usage = [usageRow("100", "own-account", "b2dff7a4-658d-811d-ab12-7d8bbe4e6157", 117), usageRow("101", "own-account")];
  const response = await f.call("/usage?key=17&limit=1");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { records: { id: string }[] }).records.map((row) => row.id), ["101"]);
});

test("usage requires session or key and rejects invalid limits and secret-shaped keys locally", async () => {
  const f = await fixture();
  for (const query of ["", "session=", "status=success", "key=", "key=0", "key=-1", "key=1.5", "key=obviously-fake-secret", "key=9007199254740992", "session=fake&limit=0", "session=fake&limit=-1", "session=fake&limit=1.5", "session=fake&limit=nope", `session=${"x".repeat(257)}`]) {
    await error(await f.call(`/usage?${query}`), "invalid_query");
  }
  assert.equal(f.home.calls.length, 0); assert.equal(f.storage.gets, 0);
});

test("usage bypasses an in-flight attribution request without touching its storage", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]); f.home.usage = [usageRow("101", "own-account")];
  const started = await f.start();
  const entered = deferred(); const release = deferred();
  f.home.override = async (path) => {
    if (path.includes("/oauth/status")) { entered.resolve(); await release.promise; }
    return undefined;
  };
  const pending = f.poll(started); await entered.promise;
  const before = { reads: f.storage.gets, writes: f.storage.puts, alarms: f.storage.alarmReads };
  const read = f.call("/usage?key=17");
  try {
    await withoutWaitingForGate(read);
    const response = await read; assert.equal(response.status, 200);
    assert.equal((await response.json() as { records: unknown[] }).records.length, 1);
    assert.deepEqual({ reads: f.storage.gets, writes: f.storage.puts, alarms: f.storage.alarmReads }, before);
  } finally { release.resolve(); await pending; }
});

test("usage mirrors the pinned node's UTF-8 bound for a long wire session id", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]);
  const wire = "é".repeat(128);
  const stored = "d16a0b06-7664-8b67-ac0d-efa067bd7bed";
  f.home.usage = [usageRow("101", "own-account", stored)];
  const response = await f.call(`/usage?session=${encodeURIComponent(wire)}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { records: { id: string }[] }).records.map((row) => row.id), ["101"]);
  const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
  assert.equal(new URL(`https://home.example${path}`).searchParams.get("session_id"), stored);
});


// Generated by running the pinned v8.0.40 Go NormalizeExplicitID,
// BoundSessionIdentity and NormalizeToCanonicalUUID functions, in that order.
const usageSessionVectors = [
  ["run", "f155da03-d152-8924-be25-2d100c00c1d7"],
  ["550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000"],
  ["derived:ctx:v1:run", "f155da03-d152-8924-be25-2d100c00c1d7"],
  ["custom:550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000"],
  ["outer:inner:550E8400-E29B-41D4-A716-446655440000", "02639ad8-c182-8e20-a7cb-707e08105f0b"],
  ["é".repeat(128), "d16a0b06-7664-8b67-ac0d-efa067bd7bed"],
] as const;
for (const [wire, expected] of usageSessionVectors) {
  test(`usage canonical session matches pinned Go vector ${wire.slice(0, 55)}`, async () => {
    const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.usage = [usageRow("101", "own-account", expected)];
    const response = await f.call(`/usage?session=${encodeURIComponent(wire)}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { records: unknown[] }).records.length, 1);
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    assert.equal(new URL(`https://home.example${path}`).searchParams.get("session_id"), expected);
  });
}

test("usage rejects controls before trimming a wire session", async () => {
  const f = await fixture();
  for (const wire of ["run\n", "\trun", "run\r", "run\u0085", "run\0", "header:"]) {
    await error(await f.call(`/usage?session=${encodeURIComponent(wire)}&key=17`), "invalid_query");
  }
  assert.equal(f.home.calls.length, 0);
});

for (const [input, canonical, outcome, code] of [
  ["success", "success", "success", 200], ["succeeded", "success", "success", 200], ["ok", "success", "success", 200],
  ["failed", "failed", "failed", 503], ["failure", "failed", "failed", 503], ["error", "failed", "failed", 503],
  ["200", "200", "success", 200], ["503", "503", "failed", 503],
] as const) {
  test(`usage status ${input} is sent as ${canonical} and preserves matching rows`, async () => {
    const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.usage = [{ ...usageRow("101", "own-account", undefined, 17, outcome), status_code: code }];
    const response = await f.call(`/usage?key=17&status=${input}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { records: unknown[] }).records.length, 1);
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    assert.equal(new URL(`https://home.example${path}`).searchParams.get("status"), canonical);
  });
}

test("usage rejects unknown outcomes and non-plain HTTP status codes locally", async () => {
  const f = await fixture();
  for (const status of ["", "unknown", "+200", "0200", "200.0", "200x", "99", "600", "-200"]) {
    await error(await f.call(`/usage?key=17&status=${encodeURIComponent(status)}`), "invalid_query");
  }
  assert.equal(f.home.calls.length, 0);
});

for (const ownAtBoundary of [false, true]) {
  test(`usage scans at most five 200-row pages and returns matches found, boundary=${ownAtBoundary}`, async () => {
    const f = await fixture(); f.home.addGroup("pool-a", 1, ["own-account"]); f.home.addGroup("pool-b", 2, ["other-account"]);
    f.home.usage = Array.from({ length: 1_001 }, (_, i) => usageRow(String(i + 1),
      i === 0 || (ownAtBoundary && i === 999) || i === 1_000 ? "own-account" : "other-account"));
    const response = await f.call("/usage?session=fake-run&limit=20");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { records: { id: string }[] }).records.map((row) => row.id), ownAtBoundary ? ["1", "1000"] : ["1"]);
    const calls = f.home.calls.filter((call) => call.path.includes("/usage/records?"));
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map((call) => {
      const query = new URL(`https://home.example${call.path}`).searchParams;
      assert.equal(query.get("limit"), "200");
      return Number(query.get("offset"));
    }), [0, 200, 400, 600, 800]);
  });
}


test("observation routes deny members before reading Home or attribution", async () => {
  const f = await fixture();
  for (const [path, method] of [["/accounts/a/observations", "GET"], ["/accounts/a/observations/refresh", "POST"]]) {
    await error(await f.call(path!, { method, owner: false }), "not_owner", 403);
  }
  assert.equal(f.home.calls.length, 0);
  assert.equal(f.storage.gets, 0);
  assert.equal(f.storage.puts, 0);
});

test("observation routes keep raw diagnostics private and preserve quota on runtime rejection", async () => {
  const f = await fixture();
  f.home.addFile("a"); f.home.addGroup("pool-a", 10, ["a"]);
  f.home.files.set("a", { ...f.home.files.get("a"), status: "error" });
  const at = f.deps.now().toISOString();
  f.home.override = (path) => {
    if (path.endsWith("/quota/credentials/a")) return Response.json({
      credential: { credential_id: "a", plan: { name: "Pro", premium: true } },
      windows: [{ id: "weekly", label: "Weekly", unit: "requests", remaining: 70, limit: 100, remaining_ratio: 0.7, observed_at: at }],
      collection: { status: "success", freshness: "fresh", observed_at: at, last_attempt_at: at },
      private_diagnostic: "never-expose-this-body",
    });
    if (path.endsWith("/credentials/a/model-states")) return Response.json({ credential: { credential_id: "a", refresh_blocked: true,
      last_error: { http_status: 401, message: "never-expose-this-body" } } });
    return undefined;
  };
  const response = await f.call("/accounts/a/observations");
  assert.equal(response.status, 200, await response.clone().text());
  const serialized = await response.text();
  assert.equal(serialized.includes("never-expose-this-body"), false);
  const result = JSON.parse(serialized);
  assert.equal(result.account.credentialFailure, "unauthorized");
  assert.equal(result.observation.observation.plan.label, "Pro");
  assert.deepEqual(result.observation.observation.windows.map((w: { id: string }) => w.id), ["weekly"]);
  assert.equal(result.observation.observation.windows[0].measure.limit, 100);
  await error(await f.call("/accounts/a/observations", { pool: "pool-b" }), "not_found", 404);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 0);
  assert.equal(f.storage.puts, 0, "observing never persists or expires OAuth attribution");
});

test("explicit observation refresh coalesces collection and preserves its persistent cap", async () => {
  const f = await fixture();
  f.home.addFile("a"); f.home.addGroup("pool-a", 10, ["a"]);
  let collected = false;
  f.home.override = (path) => {
    if (path.endsWith("/quota/collect")) {
      collected = true;
      return Response.json({ accepted: 1, running: true }, { status: 202 });
    }
    if (path.endsWith("/quota/credentials/a")) return Response.json({
      credential: { credential_id: "a" },
      windows: [{ id: "weekly", label: "Weekly", unit: "requests", remaining: 12, limit: 20, observed_at: f.deps.now().toISOString() }],
      collection: { status: collected ? "success" : "idle", freshness: collected ? "fresh" : "never",
        observed_at: collected ? f.deps.now().toISOString() : null,
        last_attempt_at: collected ? f.deps.now().toISOString() : null },
    });
    return undefined;
  };
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.call("/accounts/a/observations/refresh", { method: "POST" })));
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { observation: { observation: { windows: { id: string }[] } } };
    assert.deepEqual(result.observation.observation.windows.map((window) => window.id), ["weekly"]);
  }
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 1);
  f.restart();
  assert.equal((await f.call("/accounts/a/observations/refresh", { method: "POST" })).status, 200);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 1);
});

test("native removal records owner intent after deletion acknowledgement and hides it from members", async () => {
  const f = await fixture(["fake-member"]);
  f.home.addFile("deliberate");
  f.home.addGroup("pool-a", 10, ["deliberate"]);
  assert.equal((await f.call("/accounts/deliberate", { method: "DELETE", owner: false })).status, 403);
  assert.equal((await f.call("/accounts/deliberate", { method: "DELETE" })).status, 200);
  const own = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(own.removals, { since: null, items: [{ account: "deliberate", actor: "fake-owner", at: "2026-01-01T00:00:00.000Z" }] });
  const member = await (await f.call("/pool", { owner: false })).json() as PoolView;
  assert.equal(Object.hasOwn(member, "removals"), false);
  f.restart();
  assert.deepEqual((await (await f.call("/pool")).json() as PoolView).removals, own.removals);
});

test("a refused credential deletion cannot create a removal-intent receipt", async () => {
  const f = await fixture();
  f.home.addFile("retained");
  f.home.addGroup("pool-a", 10, ["retained"]);
  f.home.override = (path, init) => path.includes("/credentials?id=retained") && init?.method === "DELETE" ? Response.json({}, { status: 500 }) : undefined;
  assert.equal((await f.call("/accounts/retained", { method: "DELETE" })).status, 503);
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(view.removals, { since: null, items: [] });
  assert.deepEqual(view.accounts.map((account) => account.id), ["retained"]);
});


test("native removal intent follows observations made while deletion awaits acknowledgement", async () => {
  const f = await fixture();
  f.home.addFile("delayed"); f.home.addGroup("pool-a", 10, ["delayed"]);
  const entered = deferred(), release = deferred();
  f.home.override = async (path, init) => {
    if (path.includes("/credentials?id=delayed") && init?.method === "DELETE") {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const removing = f.call("/accounts/delayed", { method: "DELETE" });
  await entered.promise;
  let observedAt: number;
  try {
    f.advance(1000);
    const during = await (await f.call("/pool")).json() as PoolView;
    assert.equal(during.accounts[0]!.id, "delayed");
    observedAt = f.deps.now().getTime();
    f.advance(1000);
  } finally { release.resolve(); }
  assert.equal((await removing).status, 200);
  const after = await (await f.call("/pool")).json() as PoolView;
  assert.equal(after.accounts.length, 0);
  assert.ok(Date.parse(after.removals!.items[0]!.at) >= observedAt);
  assert.equal(after.removals!.items[0]!.at, f.deps.now().toISOString());
});

for (const order of ["native-first", "legacy-first"] as const) {
  test(`a ${order} global sign-in stays out of a legacy pool's directory-diff result`, async () => {
    const f = await fixture();
    f.home.flow = "device";
    const global = async () => {
      const response = await f.acquire("start");
      assert.equal(response.status, 200, await response.clone().text());
      const value = await response.json() as { session: string; paste?: unknown };
      assert.equal(value.paste, undefined, "an explicit device flow never asks for a callback URL");
      return value;
    };
    let legacy: SignInStarted;
    let native: { session: string };
    if (order === "native-first") { native = await global(); legacy = await f.start(); }
    else { legacy = await f.start(); native = await global(); }
    const legacyState = state(legacy);
    const nativeState = [...f.home.sessions.keys()].find((key) => key !== legacyState)!;
    const pending = f.storage.values.get(attributionStorageKey) as { locks: Record<string, { unconfirmedUploads?: string[] }> };
    assert.equal(pending.locks[provider]?.unconfirmedUploads?.length, 1);
    f.home.addFile("global-account");
    f.home.sessions.set(nativeState, { provider, status: "ok", auth_ids: ["global-account"] });
    const response = await f.acquire("status", { session: native.session });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { state: "connected", ref: "global-account" });
    f.home.addFile("legacy-account");
    f.home.sessions.set(legacyState, { provider, status: "ok" });
    await status(await f.poll(legacy), { status: "connected", accountId: "legacy-account" });
    assert.deepEqual(f.home.members.map((member) => member.auth_id), ["legacy-account"]);
    assert.ok(f.home.files.has("global-account"));
  });
}

test("an unresolved global sign-in prevents a legacy directory diff from claiming its credential", async () => {
  const f = await fixture();
  f.home.flow = "device";
  const legacy = await f.start();
  const response = await f.acquire("start");
  assert.equal(response.status, 200);
  f.home.addFile("global-account");
  f.home.sessions.set(state(legacy), { provider, status: "ok" });
  const result = await f.poll(legacy);
  assert.equal(result.status, 200);
  assert.equal((await result.json() as SignInStatus).status, "failed");
  assert.equal(f.home.members.length, 0);
  assert.ok(f.home.files.has("global-account"));
});

for (const outcome of ["lost-status", "missing-ids"] as const) {
  for (const order of ["native-first", "legacy-first"] as const) {
    test(`an ambiguous global ${outcome} in ${order} order cannot become a legacy pool account`, async () => {
      const f = await fixture();
      f.home.flow = "device";
      let legacy: SignInStarted;
      let native: { session: string };
      const startGlobal = async () => {
        const response = await f.acquire("start");
        assert.equal(response.status, 200);
        return await response.json() as { session: string };
      };
      if (order === "native-first") { native = await startGlobal(); legacy = await f.start(); }
      else { legacy = await f.start(); native = await startGlobal(); }
      const nativeState = [...f.home.sessions.keys()].find((key) => key !== state(legacy))!;
      f.home.addFile("global-account");
      if (outcome === "lost-status") f.home.sessions.delete(nativeState);
      else f.home.sessions.set(nativeState, { provider, status: "ok" });
      f.restart();
      const failed = await f.acquire("status", { session: native.session });
      assert.equal(failed.status, 200);
      assert.equal((await failed.json() as { state: string }).state, "failed");
      f.restart();
      f.home.sessions.set(state(legacy), { provider, status: "ok" });
      const result = await f.poll(legacy);
      assert.equal(result.status, 200);
      assert.equal((await result.json() as SignInStatus).status, "failed");
      assert.equal(f.home.members.length, 0);
      assert.ok(f.home.files.has("global-account"));
    });
  }

  test(`an ambiguous global ${outcome} retains its guard while credential reconciliation fails`, async () => {
    const f = await fixture();
    f.home.flow = "device";
    const legacy = await f.start();
    const started = await f.acquire("start");
    assert.equal(started.status, 200);
    const native = await started.json() as { session: string };
    const nativeState = [...f.home.sessions.keys()].find((key) => key !== state(legacy))!;
    f.home.addFile("global-account");
    if (outcome === "lost-status") f.home.sessions.delete(nativeState);
    else f.home.sessions.set(nativeState, { provider, status: "ok" });
    f.home.override = (path) => path.endsWith("/credentials") ? Response.json({}, { status: 503 }) : undefined;
    assert.equal((await f.acquire("status", { session: native.session })).status, 503);
    f.home.override = undefined;
    f.restart();
    const failed = await f.acquire("status", { session: native.session });
    assert.equal(failed.status, 200);
    assert.equal((await failed.json() as { state: string }).state, "failed");
    f.home.sessions.set(state(legacy), { provider, status: "ok" });
    const result = await f.poll(legacy);
    assert.equal(result.status, 200);
    assert.equal((await result.json() as SignInStatus).status, "failed");
    assert.equal(f.home.members.length, 0);
    assert.ok(f.home.files.has("global-account"));
  });
}

test("the alarm retains an unattended global result across eviction without attaching any pool", async () => {
  const f = await fixture();
  const startedResponse = await f.acquire("start");
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json() as { session: string };
  const nativeState = [...f.home.sessions.keys()][0]!;
  assert.equal(f.storage.alarm, f.deps.now().getTime() + 30_000);
  f.home.addFile("unattended-account");
  f.home.sessions.set(nativeState, { provider, status: "ok", auth_ids: ["unattended-account"] });
  f.advance(30_000);
  f.restart();
  await f.expire();
  f.home.sessions.clear();
  f.restart();
  const before = f.home.calls.length;
  const response = await f.acquire("status", { session: started.session });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "connected", ref: "unattended-account" });
  assert.equal(f.home.calls.length, before, "a lost Home result is served from the durable answer");
  assert.equal(f.home.members.length, 0);
});
