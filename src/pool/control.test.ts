import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolView, SignInStarted, SignInStatus } from "../../apps/pool/contract.ts";
import { attributionStorageKey, PoolControl, type ControlStorage } from "./attribution.ts";
import { handleControl } from "./control.ts";
import providers from "./providers.json" with { type: "json" };
import { signPoolToken } from "./token.ts";

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
  puts = 0;
  alarmReads = 0;
  async get<T>(key: string): Promise<T | undefined> { this.gets++; return structuredClone(this.values.get(key)) as T | undefined; }
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
      const state = new URL(String(body.redirect_url)).searchParams.get("state")!;
      assert.equal(this.sessions.get(state)?.provider, body.provider);
      return Response.json({ status: "ok" });
    }
    if (endpoint === "/oauth/status") {
      assert.ok(url.searchParams.get("state"), "never poll without a backend state");
      const session = this.sessions.get(url.searchParams.get("state")!);
      return session ? Response.json(session) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (endpoint === "/oauth/session") {
      assert.equal(method, "DELETE");
      this.sessions.delete(url.searchParams.get("state")!);
      return Response.json({ status: "ok" });
    }
    if (endpoint === "/credentials") {
      if (method === "POST") {
        const id = `upload-${++this.sequence}`;
        this.files.set(id, { ...body, id, provider: body.type });
        return Response.json({ status: "ok", name: `${id}.json` });
      }
      if (method === "DELETE") { this.files.delete(url.searchParams.get("id")!); return Response.json({ status: "ok" }); }
      return Response.json({ files: [...this.files.values()] });
    }
    if (endpoint === "/quota/credentials") return Response.json({ items: this.quota });
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
      return Response.json({ channel_group_details: this.members.filter((item) => item.channel_group_id === Number(url.searchParams.get("channel_group_id"))) });
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
interface Options { pool?: string; owner?: boolean; token?: string; body?: unknown; raw?: string; method?: string }
async function fixture() {
  const home = new FakeHome();
  const storage = new MemoryStorage();
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const deps = { signingKey, home: home.fetch, now: () => new Date(time) };
  let control = new PoolControl(storage, deps);
  const tokens = new Map<string, string>();
  async function request(path: string, options: Options = {}): Promise<Request> {
    const pool = options.pool ?? "pool-a";
    if (!tokens.has(pool)) tokens.set(pool, await signPoolToken(signingKey, { pool, owner: "fake-owner", organization: "fake-org" }));
    return new Request(`https://pool.example/pool/v1${path}`, {
      method: options.method ?? (options.body !== undefined || options.raw !== undefined ? "POST" : "GET"),
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
  return { home, storage, deps, request, call, start, callback, poll, advance: (ms: number) => { time += ms; }, expire: () => control.expire(), restart: () => { control = new PoolControl(storage, deps); } };
}
async function error(response: Response, code: string, status = 400) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json() as Row).error, code);
}
async function status(response: Response, expected: SignInStatus) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected); }

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
  assert.deepEqual(f.home.calls.map((call) => call.path), ["/v8/management/channel-groups"]);
});

test("unknown routes and lookalike boundaries return not_found", async () => {
  const f = await fixture();
  for (const path of ["", "/", "/other", "/pool/", "/accounts/a/extra"]) await error(await f.call(path, { method: "DELETE" }), "not_found", 404);
  const response = await handleControl(new Request("https://pool.example/pool/v10/pool", { headers: (await f.request("/pool")).headers }), { ...f.deps, attribution: null });
  await error(response, "not_found", 404);
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

for (const release of ["cancel", "expiry", "abandon"] as const) {
  test(`device lock blocks a second pool and releases after ${release}`, async () => {
    const f = await fixture(); f.home.flow = "device";
    const first = await f.start();
    await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
    assert.equal(f.home.sessions.size, 1);
    if (release === "cancel") await f.call(`/sign-ins?session=${encodeURIComponent(first.session)}`, { method: "DELETE" });
    else { f.advance(release === "expiry" ? 20 * 60_000 : 60_000); await f.expire(); }
    assert.ok(f.home.calls.some((call) => call.method === "DELETE" && call.path.includes(`/oauth/session?state=${state(first)}`)));
    await f.start("pool-b");
  });
}

test("device polling extends the 60 second lease, including across DO restart", async () => {
  const f = await fixture(); f.home.flow = "device";
  const started = await f.start();
  assert.equal(f.storage.alarm, Date.parse("2026-01-01T00:01:00.000Z"));
  f.advance(50_000); await f.poll(started); f.restart(); f.advance(20_000); await f.expire();
  assert.ok(f.home.sessions.has(state(started)));
  await error(await f.call("/sign-ins", { pool: "pool-b", body: { provider } }), "busy", 409);
  f.advance(40_000); await f.expire();
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

test("re-signing an existing credential connects without adding an account", async () => {
  const f = await fixture(); f.home.addFile("existing");
  const started = await f.start(); await f.callback(started); f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started), { status: "connected", accountId: null });
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
  f.home.addFile("foreign"); f.home.addFile("z", provider, { disabled: true, unavailable: true, status: "error", email: "fake@example.invalid" });
  f.home.addFile("a", provider, { unavailable: true }); f.home.addFile("u"); f.home.addFile("e", provider, { status: "error", status_message: "Needs sign-in" });
  f.home.quota = [{ credential_id: "z", plan: { name: "Example plan" }, observed_at: "2026-01-01T00:00:00Z", primary_windows: [
    { id: "high", label: "High", remaining_ratio: 2, reset_at: "2026-01-02T00:00:00Z", window_seconds: 3600 },
    { id: "low", used_ratio: 2 }, { id: "unknown" }, { id: "unlimited", is_unlimited: true, remaining_ratio: 0, reset_at: "ignored" },
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

test("login file keeps raw JSON and rejects arrays, null, malformed, oversized and backend 400", async () => {
  const f = await fixture(); const raw = `{ "type" : ${JSON.stringify(provider)}, "refresh_token": "obviously-fake" }`;
  assert.equal((await f.call("/login-files", { raw })).status, 200);
  assert.equal(f.home.calls.find((call) => call.path.endsWith("/credentials") && call.method === "POST")!.body, raw);
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
    assert.equal(f.home.calls.length, 1);
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

test("a definite auth-url rejection releases its pre-session reservation without retry", async () => {
  const f = await fixture();
  f.home.override = (path) => path.includes("/oauth/auth-url") ? Response.json({ error: "rejected" }, { status: 400 }) : undefined;
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
  assert.equal(response.headers.get("Retry-After"), "10");
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/oauth/callback")).length, 1);
});

test("a lost upload response cannot turn a re-sign into another pool's new account", async () => {
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
  assert.equal(f.storage.gets, 0);
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
    assert.deepEqual({ reads: f.storage.gets, writes: f.storage.puts, alarms: f.storage.alarmReads }, before);
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
    f.advance(60_000);
    f.home.override = (path) => {
      if (path.includes(`/oauth/session?state=${state(first)}`)) {
        if (failure === "network") throw new Error("fake cancellation outage");
        return Response.json({ error: "fake failure" }, { status: Number(failure) });
      }
      return undefined;
    };
    await f.expire();
    assert.ok(f.home.sessions.has(state(first)), "the failed cancellation keeps its stale lock");
    assert.equal(f.home.sessions.has(state(second)), false, "another provider is still cancelled");
    await f.start("pool-b", otherProvider);
    await error(await f.call("/sign-ins", { body: { provider } }), "busy", 409);
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

test("pool view reads credentials and quota concurrently and reuses cached channel groups", async () => {
  const f = await fixture(); f.home.addGroup("pool-a", 1, ["account"]); f.home.addFile("account");
  const entered = deferred(); const release = deferred();
  f.home.override = async (path) => {
    if (path.endsWith("/credentials")) { entered.resolve(); await release.promise; }
    return undefined;
  };
  const reading = f.call("/pool"); await entered.promise; await nextTurn();
  try { assert.ok(f.home.calls.some((call) => call.path.includes("/quota/credentials?"))); }
  finally { release.resolve(); await reading; }
  f.home.override = undefined;
  await f.call("/pool");
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/channel-groups")).length, 1);
  // A deleted cached group is re-discovered after Home's 404.
  f.home.groups = [{ id: 4, channel_name: "signalbox-pool-pool-a" }];
  f.home.members = [{ id: 4, channel_group_id: 4, auth_id: "account" }];
  f.home.override = (path) => path.endsWith("/channel-group-details?channel_group_id=1") ? Response.json({ error: "not_found" }, { status: 404 }) : undefined;
  const view = await (await f.call("/pool")).json() as PoolView;
  assert.deepEqual(view.accounts.map((account) => account.id), ["account"]);
});

test("global memberships use bounded concurrency and add reuses the ownership snapshot", async () => {
  const f = await fixture();
  for (let i = 1; i <= 9; i++) f.home.addGroup(i === 1 ? "pool-a" : `other-${i}`, i, []);
  let active = 0; let maximum = 0;
  f.home.override = async (path) => {
    if (path.includes("/channel-group-details?")) {
      active++; maximum = Math.max(maximum, active); await nextTurn(); active--;
    }
    return undefined;
  };
  const started = await f.start(); f.home.addFile("new-account");
  Object.assign(f.home.sessions.get(state(started))!, { status: "ok", auth_id: "new-account" });
  await status(await f.poll(started), { status: "connected", accountId: "new-account" });
  assert.equal(maximum, 4);
  assert.equal(f.home.calls.filter((call) => call.path.includes("/channel-group-details?")).length, 9);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/channel-groups")).length, 1);
});

test("an early shared alarm re-arms the current device grace after polling extends it", async () => {
  const f = await fixture(); f.home.flow = "device";
  const started = await f.start();
  f.advance(50_000); await f.poll(started);
  f.advance(10_000);
  // The warm-up lifecycle has replaced the fired alarm with its next five-minute alarm.
  f.storage.alarm = Date.parse("2026-01-01T00:06:00.000Z");
  await f.expire();
  assert.equal(f.storage.alarm, Date.parse("2026-01-01T00:01:50.000Z"));
  assert.ok(f.home.sessions.has(state(started)));
  f.advance(50_000); await f.expire();
  assert.equal(f.home.sessions.has(state(started)), false);
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
  // An empty re-sign must not take a legacy upload whose membership write had no acknowledgement.
  f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started), { status: "connected", accountId: null });
  const current = f.storage.values.get(attributionStorageKey) as { version: number; assigned: string[] };
  assert.equal(current.version, 2);
  assert.deepEqual(current.assigned, ["pending-sign-in"]);
});

test("confirmed membership removal clears assignment markers even if credential deletion fails", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["partial-remove"]); f.home.addFile("partial-remove");
  f.storage.values.set(attributionStorageKey, { version: 2, locks: {}, sessions: {}, assigned: ["partial-remove"] });
  f.home.override = (path, init) => path.includes("/credentials?id=") && init?.method === "DELETE"
    ? Response.json({ error: "fake delete failure" }, { status: 503 }) : undefined;
  await error(await f.call("/accounts/partial-remove", { method: "DELETE" }), "backend_unavailable", 503);
  assert.equal(f.home.members.length, 0);
  assert.deepEqual((f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned, []);
  f.home.override = (path, init) => path.endsWith("/credentials") && init?.method === "POST"
    ? Response.json({ status: "ok", name: "partial-remove.json" }) : undefined;
  assert.equal((await f.call("/login-files", { body: { type: provider } })).status, 200);
  assert.deepEqual(f.home.members.map((member) => member.auth_id), ["partial-remove"]);
});

test("a failed credential deletion cannot expose the removed upload to an overlapping sign-in", async () => {
  const f = await fixture(); const started = await f.start("pool-b"); await f.callback(started, "pool-b");
  const uploaded = await (await f.call("/login-files", { body: { type: provider } })).json() as { accountId: string };
  f.home.override = (path, init) => path.includes("/credentials?id=") && init?.method === "DELETE"
    ? Response.json({ error: "fake delete failure" }, { status: 503 }) : undefined;
  await error(await f.call(`/accounts/${uploaded.accountId}`, { method: "DELETE" }), "backend_unavailable", 503);
  f.home.override = undefined;
  f.home.sessions.get(state(started))!.status = "ok";
  await status(await f.poll(started, "pool-b"), { status: "connected", accountId: null });
  assert.equal(f.home.members.length, 0);
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
  f.home.override = (path, init) => path.endsWith("/credentials") && init?.method === "POST"
    ? Response.json({ status: "ok", name: "moved-account.json" }) : undefined;
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
