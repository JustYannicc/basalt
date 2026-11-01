import assert from "node:assert/strict";
import { test } from "node:test";
import { setupTtl, signIntent } from "../pool/setup-links.ts";
import type { SetupEnv } from "./session.ts";
import { handleShare } from "./share.ts";

const origin = "https://share.example";
const secret = "ab".repeat(32);
const claims = { pool: "pool-1", owner: "owner-1", organization: "organization-1", user: "manager-1" };
const accessPath = "/api/organizations/organization-1/apps/pool-1/access";
const json = (value: unknown, status = 200) => Response.json(value, { status });

function fixture(options: { canManage?: boolean; user?: string; status?: number } = {}) {
  const calls: Request[] = [];
  const env: SetupEnv = {
    POOL_APP_SIGNING_KEY: secret,
    TOOLS_SERVICE: { fetch: async (request) => {
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session") return json({ user: { id: options.user ?? claims.user, emailVerified: true } });
      assert.equal(path, accessPath);
      return json({ canManage: options.canManage ?? true, canUse: false }, options.status ?? 200);
    } },
    POOL_SERVICE: { fetch: async () => { throw Error("The old sharing adapter must never call the pool"); } },
  };
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers({ cookie: "executor-hosted.session_token=synthetic", origin });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return handleShare(new Request(`${origin}${path}`, { ...init, headers }), env);
  };
  const intent = (key = secret, expiresAt = Date.now() + setupTtl) => signIntent(key, { ...claims, expiresAt });
  const destination = async () => `/share/v1/destination?intent=${encodeURIComponent(await intent())}`;
  return { calls, request, intent, destination };
}

test("old invitations, membership removal and cap routes are retired without any service call", async () => {
  const f = fixture();
  for (const [method, path] of [
    ["POST", "/share/v1/invitations"],
    ["DELETE", "/share/v1/invitations/invite-1"],
    ["DELETE", "/share/v1/members/member-1"],
    ["PUT", "/share/v1/members/member-1/cap"],
    ["GET", "/share/v1/pool?intent=old"],
    ["GET", "/share/v1/usage?intent=old"],
  ]) {
    const response = await f.request(path!, { method, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(f.calls, []);
});

test("an old bookmark opens native settings for a current manager without granting pool use", async () => {
  const f = fixture();
  const response = await f.request(await f.destination());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { href: "/org/organization-1/apps/pool-1?view=settings" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(f.calls.map((request) => [request.method, new URL(request.url).pathname]), [
    ["GET", "/api/auth/get-session"], ["GET", accessPath],
  ]);
  assert.equal(f.calls[1]!.headers.get("cookie"), "executor-hosted.session_token=synthetic");
});

test("fresh native management authority controls the destination", async () => {
  const f = fixture({ canManage: false });
  assert.equal((await f.request(await f.destination())).status, 403);
  const unavailable = fixture({ status: 503 });
  assert.equal((await unavailable.request(await unavailable.destination())).status, 502);
  const expiredSession = fixture({ status: 401 });
  assert.equal((await expiredSession.request(await expiredSession.destination())).status, 401);
});

test("forged, expired and another person's bookmark never reaches app access", async () => {
  const f = fixture();
  for (const token of ["old", await f.intent("cd".repeat(32)), await f.intent(secret, Date.now() - 1)]) {
    const response = await f.request(`/share/v1/destination?intent=${encodeURIComponent(token)}`);
    assert.equal(response.status, 401);
  }
  assert.equal(f.calls.some((request) => new URL(request.url).pathname === accessPath), false);
  const other = fixture({ user: "someone-else" });
  assert.equal((await other.request(await other.destination())).status, 401);
  assert.equal(other.calls.length, 1);
});

test("bookmark resolution requires GET and a browser session", async () => {
  const f = fixture();
  assert.equal((await f.request(await f.destination(), { method: "POST", body: "{}" })).status, 405);
  assert.equal((await f.request(await f.destination(), { headers: { authorization: "Bearer synthetic" } })).status, 403);
  assert.deepEqual(f.calls, []);
});
