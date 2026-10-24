import assert from "node:assert/strict";
import { test } from "node:test";
import { openEnvelope } from "../pool/token.ts";
import type { SetupEnv } from "./session.ts";
import { handleShare } from "./share.ts";

const origin = "https://share.example";
const secret = "ab".repeat(32);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
type Call = { path: string; method: string; request: Request; input: Record<string, unknown> };
type Override = (call: Call) => Response | undefined | Promise<Response | undefined>;
const accessPath = "/api/organizations/organization-1/apps/pool-1/access";

function fixture(options: { tools?: Override; pool?: Override; audience?: string } = {}) {
  const calls: Call[] = [];
  let audience = options.audience ?? "private";
  const env: SetupEnv = {
    POOL_APP_SIGNING_KEY: secret,
    TOOLS_SERVICE: { fetch: async (request) => {
      const url = new URL(request.url);
      const input = request.method === "GET" ? {} : await request.json() as Record<string, unknown>;
      const call = { path: url.pathname, method: request.method, request, input };
      calls.push(call);
      const response = await options.tools?.(call);
      if (response) return response;
      if (url.pathname === "/api/auth/get-session") return json({ user: { id: "owner-1", emailVerified: true } });
      if (url.pathname === "/api/auth/organization/list-members") return json({ members: [
        { id: "member-owner", userId: "owner-1", role: "owner", user: { id: "owner-1", name: "Owner", email: "owner@example.test", image: "x" } },
        { id: "member-2", userId: "user-2", role: "member", user: { id: "user-2", name: "", email: "two@example.test" } },
      ], total: 2 });
      if (url.pathname === "/api/auth/organization/list-invitations") return json([
        { id: "invite-1", email: "three@example.test", status: "pending", role: "member", expiresAt: "2026-11-01T00:00:00.000Z", inviterId: "owner-1" },
        { id: "invite-0", email: "old@example.test", status: "accepted" },
      ]);
      if (url.pathname === accessPath && request.method === "GET") return json({ audience: { kind: audience }, revision: `rev-${audience}` });
      if (url.pathname === accessPath && request.method === "PATCH") { audience = (input.audience as { kind: string }).kind; return json({}); }
      if (url.pathname === "/api/auth/organization/invite-member") return json({ id: "invite-2", email: input.email, role: input.role, expiresAt: "2026-11-01T00:00:00.000Z" });
      if (url.pathname === "/api/auth/organization/cancel-invitation") return json({});
      if (url.pathname === "/api/auth/organization/remove-member") return json({ member: {} });
      throw Error(`Unexpected native path: ${url.pathname}`);
    } },
    POOL_SERVICE: { fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const input = await openEnvelope(secret, "sbs1", (await request.json() as { envelope: string }).envelope) as Record<string, unknown>;
      const call = { path, method: request.method, request, input };
      calls.push(call);
      const response = await options.pool?.(call);
      if (response) return response;
      if (path === "/__setup/v1/validate") return json({ pool: "pool-1", organization: "organization-1", owner: "owner-1", name: "Owner's pool" });
      throw Error(`Unexpected pool path: ${path}`);
    } },
  };
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers({ cookie: "executor-hosted.session_token=fake-cookie", origin });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return handleShare(new Request(`${origin}${path}`, { ...init, headers }), env);
  };
  const write = (path: string, body: unknown, method = "POST", headers = {}) =>
    request(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { calls, request, write, audience: () => audience };
}

test("the owner reads people and pending invitations, and nothing else about the organization", async () => {
  const f = fixture();
  const response = await f.request("/share/v1/pool?intent=signed");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    pool: { id: "pool-1", name: "Owner's pool" },
    audience: "private",
    members: [
      { id: "member-owner", name: "Owner", email: "owner@example.test", owner: true, you: true },
      { id: "member-2", name: "", email: "two@example.test", owner: false, you: false },
    ],
    invitations: [{ id: "invite-1", email: "three@example.test", expiresAt: "2026-11-01T00:00:00.000Z", link: `${origin}/invite?invitation=invite-1` }],
  });
  const validate = f.calls.find((call) => call.path === "/__setup/v1/validate")!;
  assert.equal(validate.input.user, "owner-1");
  assert.equal(validate.input.intent, "signed");
  const members = f.calls.find((call) => call.path === "/api/auth/organization/list-members")!;
  assert.equal(new URL(members.request.url).searchParams.get("organizationId"), "organization-1");
  assert.equal(members.request.headers.get("cookie"), "executor-hosted.session_token=fake-cookie");
});

test("only the pool's owner can open sharing; members get a clear refusal and no organization reads", async () => {
  const f = fixture({ pool: ({ path }) => path.endsWith("/validate") ? json({ pool: "pool-1", organization: "organization-1", owner: "someone-else" }) : undefined });
  const response = await f.request("/share/v1/pool?intent=signed");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Only the pool's owner can share it.");
  assert.deepEqual(f.calls.map((call) => call.path), ["/api/auth/get-session", "/__setup/v1/validate"]);
  const invite = await f.write("/share/v1/invitations", { intent: "signed", email: "a@example.test" });
  assert.equal(invite.status, 403);
  assert.equal(f.calls.some((call) => call.path.includes("invite-member") || call.path === accessPath), false);
});

test("inviting shares a private pool with its organization first, then invites as member only", async () => {
  const f = fixture();
  const response = await f.write("/share/v1/invitations", { intent: "signed", email: " New@Example.test " });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).invitation, {
    id: "invite-2", email: "new@example.test", expiresAt: "2026-11-01T00:00:00.000Z", link: `${origin}/invite?invitation=invite-2`,
  });
  const order = f.calls.map((call) => `${call.method} ${call.path}`).filter((step) => step.includes("access") || step.includes("invite-member"));
  assert.deepEqual(order, [`GET ${accessPath}`, `PATCH ${accessPath}`, "POST /api/auth/organization/invite-member"]);
  const patch = f.calls.find((call) => call.method === "PATCH")!;
  assert.deepEqual(patch.input, { audience: { kind: "everyone" }, revision: "rev-private" });
  assert.equal(patch.request.headers.get("origin"), origin);
  const invite = f.calls.find((call) => call.path.endsWith("/invite-member"))!;
  assert.deepEqual(invite.input, { email: "new@example.test", role: "member", organizationId: "organization-1", resend: true });
  assert.equal(f.audience(), "everyone");
});

test("a chosen role is never accepted; group and everyone sharing are left as they are", async () => {
  const roleAttempt = fixture();
  for (const role of ["admin", "owner", "member"]) {
    const response = await roleAttempt.write("/share/v1/invitations", { intent: "signed", email: "a@example.test", role });
    assert.equal(response.status, 400);
  }
  assert.equal(roleAttempt.calls.length, 0);
  for (const audience of ["groups", "everyone"]) {
    const f = fixture({ audience });
    assert.equal((await f.write("/share/v1/invitations", { intent: "signed", email: "a@example.test" })).status, 200);
    assert.equal(f.calls.some((call) => call.method === "PATCH"), false);
    assert.equal(f.audience(), audience);
  }
});

test("a sharing conflict is read again once; a failed share sends no invitation", async () => {
  let patches = 0;
  const retried = fixture({ tools: ({ method, path }) => method === "PATCH" && path === accessPath && ++patches === 1 ? json({ _tag: "AccessConflict" }, 409) : undefined });
  assert.equal((await retried.write("/share/v1/invitations", { intent: "signed", email: "a@example.test" })).status, 200);
  assert.equal(patches, 2);
  const failing = fixture({ tools: ({ method, path }) => method === "PATCH" && path === accessPath
    ? json({ message: "Couldn't update the pool's computers. Try again." }, 503) : undefined });
  const response = await failing.write("/share/v1/invitations", { intent: "signed", email: "a@example.test" });
  assert.equal(response.status, 502);
  assert.equal(failing.calls.some((call) => call.path.endsWith("/invite-member")), false);
  const invalid = fixture();
  assert.equal((await invalid.write("/share/v1/invitations", { intent: "signed", email: "not an email" })).status, 400);
  assert.equal(invalid.calls.some((call) => call.path.endsWith("/invite-member")), false);
});

test("removing a member goes through native removal; its refusal reaches the owner and can be retried", async () => {
  const f = fixture();
  const response = await f.write("/share/v1/members/member-2", { intent: "signed" }, "DELETE");
  assert.equal(response.status, 200);
  const removal = f.calls.find((call) => call.path.endsWith("/remove-member"))!;
  assert.deepEqual(removal.input, { memberIdOrEmail: "member-2", organizationId: "organization-1" });

  const owner = fixture();
  const self = await owner.write("/share/v1/members/member-owner", { intent: "signed" }, "DELETE");
  assert.equal(self.status, 409);
  assert.equal(owner.calls.some((call) => call.path.endsWith("/remove-member")), false);
  const gone = await owner.write("/share/v1/members/member-9", { intent: "signed" }, "DELETE");
  assert.equal(gone.status, 404);

  let attempts = 0;
  const flaky = fixture({ tools: ({ path }) => path.endsWith("/remove-member") && ++attempts === 1
    ? json({ message: "Couldn't stop their computers on this pool. Try again." }, 400) : undefined });
  const first = await flaky.write("/share/v1/members/member-2", { intent: "signed" }, "DELETE");
  assert.equal(first.status, 409);
  assert.equal((await first.json()).error, "Couldn't stop their computers on this pool. Try again.");
  assert.equal((await flaky.write("/share/v1/members/member-2", { intent: "signed" }, "DELETE")).status, 200);
});

test("an expired sharing session says to reopen Share, not setup", async () => {
  const f = fixture({ pool: ({ path }) => path.endsWith("/validate") ? json({ error: "unauthorized", message: "Open setup again from your pool. This setup session has expired." }, 401) : undefined });
  const response = await f.request("/share/v1/pool?intent=old");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "This sharing session expired. Open Share again from your pool.");
});

test("cancelling an invitation; writes need this origin and JSON; bearer requests are refused", async () => {
  const f = fixture();
  assert.equal((await f.write("/share/v1/invitations/invite-1", { intent: "signed" }, "DELETE")).status, 200);
  assert.deepEqual(f.calls.find((call) => call.path.endsWith("/cancel-invitation"))!.input, { invitationId: "invite-1" });
  const strict = fixture();
  assert.equal((await strict.write("/share/v1/invitations", { intent: "signed", email: "a@example.test" }, "POST", { Origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await strict.request("/share/v1/invitations", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await strict.request("/share/v1/pool?intent=signed", { headers: { authorization: "Bearer x" } })).status, 403);
  assert.equal((await strict.request("/share/v1/pool", { method: "POST" })).status, 405);
  assert.equal((await strict.request("/share/v1/elsewhere")).status, 404);
  assert.equal(strict.calls.length, 0);
});
