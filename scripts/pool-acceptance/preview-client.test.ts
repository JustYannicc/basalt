import assert from "node:assert/strict";
import test from "node:test";
import {
  PreviewClient,
  type PreviewClientConfig,
  type SetupPayload,
} from "./preview-client.ts";

const origin = "https://preview.example";
const token = "ab".repeat(32);
const config: PreviewClientConfig = {
  origin,
  email: "acceptance@example.test",
  password: "fixture-password-never-log",
  organizationId: "seeded-org",
  poolAppId: "seeded-pool-app",
};
const credentials = {
  modelUrl: origin,
  modelKey: "fixture-model-key",
  toolsUrl: `${origin}/mcp`,
  toolsToken: "fixture-tools-token",
};
const payload: SetupPayload = {
  version: 1,
  brand: {
    name: "Signalbox",
    mcpServerName: "signalbox",
    setup: { id: "basalt-computer-v1", marker: "Signalbox managed computer setup", keyPrefix: "sb_" },
    host: "preview.example",
  },
  credentials,
  instructions: "Install the preview configuration.",
};

const poolView = (accounts: { id: string }[]) => ({ isOwner: true, providers: [], accounts });
const operation = (value: unknown) => Response.json({ ok: true, value });
const contextHref = (intent: string) => `${origin}/setup#${new URLSearchParams({ intent })}`;

function assertCookieCall(init: RequestInit | undefined, cookie: string, method = "POST") {
  assert.equal(init?.method, method);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("cookie"), cookie);
  assert.equal(headers.get("origin"), origin);
  assert.equal(headers.get("authorization"), null);
  assert.equal(init?.redirect, "error");
}

test("public app, setup, revoke, and sign-out flows preserve the cookie boundary", async () => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  let contextNumber = 0;
  let listNumber = 0;
  let poolAccounts: { id: string }[] = [];
  let claimCount = 0;
  let now = 0;
  const client = new PreviewClient(config, {
    now: () => now,
    delay: async (ms) => { now += ms; },
    computerWaitMs: 5_000,
    computerPollMs: 250,
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      calls.push({ url, init });
      assert.equal(init?.redirect, "error");
      assert.ok(!url.pathname.startsWith("/pool/v1/"));
      assert.ok(!url.pathname.startsWith("/__setup/"));

      if (url.pathname === "/api/auth/sign-in/email") {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("origin"), origin);
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        assert.deepEqual(JSON.parse(String(init?.body)), {
          email: config.email,
          password: config.password,
        });
        const response = Response.json({ user: { id: "owner-1" } });
        response.headers.append("set-cookie", "executor-hosted.session_token=session-a; Path=/; HttpOnly; SameSite=Lax");
        response.headers.append("set-cookie", "executor-hosted.session_data=data-a; Path=/; HttpOnly");
        return response;
      }

      if (url.pathname.endsWith("/data/query")) {
        assertCookieCall(init, "executor-hosted.session_token=session-a; executor-hosted.session_data=data-a");
        assert.equal(url.pathname, "/api/organizations/seeded-org/apps/seeded-pool-app/data/query");
        const body = JSON.parse(String(init?.body));
        if (body.name === "view") return operation(poolView(poolAccounts));
        assert.equal(body.name, "computerContext");
        assert.deepEqual(body.input, {});
        contextNumber += 1;
        return operation({ href: contextHref(`intent-${contextNumber}`), computers: [], undoPrompt: "undo" });
      }

      if (url.pathname.endsWith("/data/mutate")) {
        assertCookieCall(init, "executor-hosted.session_token=session-a; executor-hosted.session_data=data-a");
        assert.equal(url.pathname, "/api/organizations/seeded-org/apps/seeded-pool-app/data/mutate");
        const body = JSON.parse(String(init?.body));
        if (body.name === "addLoginFile") {
          assert.deepEqual(body.input, { file: { access_token: "fixture-login-file" } });
          poolAccounts = [...poolAccounts, { id: "account-claude" }];
          return operation({ accountId: "account-claude" });
        }
        assert.equal(body.name, "removeAccount");
        assert.deepEqual(body.input, { id: "account-claude" });
        poolAccounts = poolAccounts.filter((account) => account.id !== body.input.id);
        return operation(null);
      }

      if (url.pathname === "/setup/v1/links") {
        assertCookieCall(init, "executor-hosted.session_token=session-a; executor-hosted.session_data=data-a");
        assert.deepEqual(JSON.parse(String(init?.body)), { intent: `intent-${contextNumber}`, name: "Work laptop" });
        return Response.json({
          computerId: "computer-1",
          prompt: `Open ${origin}/setup/claim/${token} for one-time instructions.`,
          // The public prompt is authoritative; a bare-link field must not be relied on.
          link: "https://attacker.example/claim/not-the-link",
        });
      }

      if (url.pathname === `/setup/claim/${token}`) {
        claimCount += 1;
        assert.equal(claimCount, 1);
        assert.equal(url.search, "?format=json");
        assert.equal(new Headers(init?.headers).get("cookie"), null);
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        return Response.json(payload);
      }

      if (url.pathname === "/setup/v1/computers") {
        assertCookieCall(init, "executor-hosted.session_token=session-a; executor-hosted.session_data=data-a", "GET");
        assert.equal(url.searchParams.get("intent"), `intent-${contextNumber}`);
        listNumber += 1;
        return Response.json({ computers: [listNumber === 3 ? {
          id: "computer-1",
          state: "revoked",
          firstModelRequestAt: "2026-10-24T08:12:13.456Z",
          firstToolCallAt: "2026-10-24T08:12:14.000Z",
          revokedAt: "2026-10-24T08:13:00.000Z",
        } : {
          id: "computer-1",
          state: "active",
          firstModelRequestAt: listNumber === 1 ? null : "2026-10-24T08:12:13.456Z",
          firstToolCallAt: listNumber === 1 ? null : "2026-10-24T08:12:14.000Z",
          revokedAt: null,
        }] });
      }

      if (url.pathname === "/setup/v1/computers/computer-1") {
        assertCookieCall(init, "executor-hosted.session_token=session-a; executor-hosted.session_data=data-a", "DELETE");
        assert.equal(url.searchParams.get("intent"), `intent-${contextNumber}`);
        return Response.json({ success: true });
      }

      if (url.pathname === "/v1/messages") {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credentials.modelKey}`);
        assert.equal(new Headers(init?.headers).get("x-api-key"), null);
        assert.equal(new Headers(init?.headers).get("cookie"), null);
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "claude-sonnet-4-6",
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        });
        return new Response("private model refusal body", { status: 401 });
      }

      if (url.pathname === "/mcp") {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credentials.toolsToken}`);
        assert.equal(new Headers(init?.headers).get("cookie"), null);
        assert.deepEqual(JSON.parse(String(init?.body)), {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search", arguments: { query: "pool", limit: 1 } },
        });
        return new Response(null, { status: 403 });
      }

      if (url.pathname === "/api/auth/sign-out") {
        assertCookieCall(init, "executor-hosted.session_token=session-a; executor-hosted.session_data=data-a");
        assert.deepEqual(JSON.parse(String(init?.body)), {});
        return Response.json({ success: true });
      }

      if (url.pathname === "/api/auth/get-session") {
        assert.equal(init?.method, "GET");
        assert.equal(new Headers(init?.headers).get("cookie"), "executor-hosted.session_token=session-a; executor-hosted.session_data=data-a");
        return Response.json(null);
      }

      throw new Error(`Unexpected fixture route ${url.pathname}`);
    },
  });

  await client.signIn();
  await client.verifyEmptyPool();
  const accountId = await client.importAccount({ access_token: "fixture-login-file" });
  assert.equal(accountId, "account-claude");
  assert.deepEqual(await client.poolView(), { isOwner: true, accounts: [{ id: "account-claude" }] });
  await client.verifyAccounts([accountId]);
  await client.removeAccount(accountId);
  await client.verifyAccountsRemoved([accountId]);

  const created = await client.claimComputer("Work laptop");
  assert.equal(created.id, "computer-1");
  assert.deepEqual(created.payload.credentials, credentials);
  assert.equal(claimCount, 1);
  assert.deepEqual(await client.waitForComputer(created.id), {
    firstModelRequestAt: "2026-10-24T08:12:13.456Z",
    firstToolCallAt: "2026-10-24T08:12:14.000Z",
  });
  await client.revokeComputer(created.id);
  await client.verifyRevoked(created.payload.credentials, { client: "claude", model: "claude-sonnet-4-6" });
  await client.signOut();

  const contextQueries = calls.filter(({ url, init }) => url.pathname.endsWith("/data/query") &&
    JSON.parse(String(init?.body)).name === "computerContext");
  assert.equal(contextQueries.length, 5); // create, each list read, and revoke plus its public status check get fresh intents
  assert.equal(listNumber, 3);
  assert.ok(calls.some(({ url }) => url.pathname === "/api/auth/sign-out"));
});

test("claim uses only the prompt URL and rejects a model credential from another origin", async () => {
  const requests: string[] = [];
  const client = new PreviewClient(config, {
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      requests.push(url.pathname);
      if (url.pathname === "/api/auth/sign-in/email") {
        const response = Response.json({ user: { id: "owner-1" } });
        response.headers.set("set-cookie", "executor-hosted.session_token=session-a; Path=/; HttpOnly");
        return response;
      }
      if (url.pathname.endsWith("/data/query")) {
        return operation({ href: contextHref("fresh-intent") });
      }
      if (url.pathname === "/setup/v1/links") {
        return Response.json({
          computerId: "computer-2",
          prompt: `Open ${origin}/setup/claim/${token} to continue.`,
          link: `${origin}/setup/claim/${"cd".repeat(32)}`,
        });
      }
      if (url.pathname === `/setup/claim/${token}`) {
        return Response.json({ ...payload, credentials: { ...credentials, modelUrl: "https://wrong.example" } });
      }
      if (url.pathname === "/setup/v1/computers/computer-2") return Response.json({ success: true });
      if (url.pathname === "/setup/v1/computers") return Response.json({ computers: [{
        id: "computer-2", state: "revoked", revokedAt: "2026-10-24T08:13:00.000Z",
      }] });
      throw new Error(`Unexpected fixture route ${url.pathname}`);
    },
  });

  await client.signIn();
  await assert.rejects(client.claimComputer("Other laptop"), /model URL did not match the preview origin/);
  assert.deepEqual(requests, [
    "/api/auth/sign-in/email",
    "/api/organizations/seeded-org/apps/seeded-pool-app/data/query",
    "/setup/v1/links",
    `/setup/claim/${token}`,
    "/api/organizations/seeded-org/apps/seeded-pool-app/data/query",
    "/setup/v1/computers/computer-2",
    "/api/organizations/seeded-org/apps/seeded-pool-app/data/query",
    "/setup/v1/computers",
  ]);
});

test("a bare claim field is not accepted and one-time claims are never retried", async () => {
  let claimRequests = 0;
  let bareLinkOnly = true;
  const client = new PreviewClient(config, {
    fetch: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/auth/sign-in/email") {
        const response = Response.json({ user: { id: "owner-1" } });
        response.headers.set("set-cookie", "executor-hosted.session_token=session-a; Path=/; HttpOnly");
        return response;
      }
      if (url.pathname.endsWith("/data/query")) return operation({ href: contextHref("intent") });
      if (url.pathname === "/setup/v1/links") {
        return Response.json({
          computerId: "computer-3",
          prompt: bareLinkOnly ? "One-time setup is ready." : `Open ${origin}/setup/claim/${token}.`,
          link: `${origin}/setup/claim/${token}`,
        });
      }
      if (url.pathname === `/setup/claim/${token}`) {
        claimRequests += 1;
        return new Response("expired one-time claim", { status: 410 });
      }
      if (url.pathname === "/setup/v1/computers/computer-3") return Response.json({ success: true });
      if (url.pathname === "/setup/v1/computers") return Response.json({ computers: [{
        id: "computer-3", state: "revoked", revokedAt: "2026-10-24T08:13:00.000Z",
      }] });
      throw new Error(`Unexpected fixture route ${url.pathname}`);
    },
  });

  await client.signIn();
  await assert.rejects(client.claimComputer("No prompt URL"), /exactly one claim URL/);
  assert.equal(claimRequests, 0);
  bareLinkOnly = false;
  await assert.rejects(client.claimComputer("Consumed link"), /Setup claim returned HTTP 410/);
  assert.equal(claimRequests, 1);
});

test("computer evidence requires the exact active ID and canonical ISO timestamps", async (t) => {
  for (const [label, computer, failure] of [
    ["wrong ID", { id: "another", state: "active", firstModelRequestAt: null, firstToolCallAt: null }, /exactly the created computer/],
    ["inactive", { id: "computer-1", state: "issuing", firstModelRequestAt: null, firstToolCallAt: null }, /was not active/],
    ["non-ISO time", { id: "computer-1", state: "active", firstModelRequestAt: "2026-10-24", firstToolCallAt: null }, /not an ISO timestamp/],
  ] as const) {
    await t.test(label, async () => {
      const client = new PreviewClient(config, {
        fetch: async (input) => {
          const url = new URL(input.toString());
          if (url.pathname === "/api/auth/sign-in/email") {
            const response = Response.json({ user: { id: "owner-1" } });
            response.headers.set("set-cookie", "executor-hosted.session_token=session-a; Path=/; HttpOnly");
            return response;
          }
          if (url.pathname.endsWith("/data/query")) return operation({ href: contextHref("fresh-intent") });
          if (url.pathname === "/setup/v1/computers") return Response.json({ computers: [computer] });
          throw new Error(`Unexpected fixture route ${url.pathname}`);
        },
      });
      await client.signIn();
      await assert.rejects(client.waitForComputer("computer-1"), failure);
    });
  }
});

test("HTTP failures never expose response bodies or credentials", async () => {
  const client = new PreviewClient(config, {
    fetch: async (input) => {
      assert.equal(new URL(input.toString()).pathname, "/api/auth/sign-in/email");
      return new Response("private body containing fixture-password-never-log", { status: 401 });
    },
  });
  await assert.rejects(client.signIn(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /private body|fixture-password/);
    return true;
  });
});

test("sign-in retains issued cookies before validating the response and sign-out checks the old cookie", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const client = new PreviewClient(config, {
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      calls.push({ path: url.pathname, init });
      if (url.pathname === "/api/auth/sign-in/email") {
        const response = new Response("malformed sign-in response", { status: 200 });
        response.headers.set("set-cookie", "executor-hosted.session_token=session-kept; Path=/; HttpOnly");
        return response;
      }
      if (url.pathname === "/api/auth/sign-out") {
        assert.equal(new Headers(init?.headers).get("cookie"), "executor-hosted.session_token=session-kept");
        return Response.json({ success: true });
      }
      if (url.pathname === "/api/auth/get-session") {
        assert.equal(new Headers(init?.headers).get("cookie"), "executor-hosted.session_token=session-kept");
        return Response.json(null);
      }
      throw new Error(`Unexpected fixture route ${url.pathname}`);
    },
  });

  await assert.rejects(client.signIn(), /Preview sign-in did not return valid JSON/);
  await client.signOut();
  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/auth/sign-in/email",
    "/api/auth/sign-out",
    "/api/auth/get-session",
  ]);
});

test("sign-out rejects a malformed HTTP 200 session payload", async () => {
  const client = new PreviewClient(config, {
    fetch: async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/auth/sign-in/email") {
        const response = Response.json({ user: { id: "owner-1" } });
        response.headers.set("set-cookie", "executor-hosted.session_token=session-a; Path=/; HttpOnly");
        return response;
      }
      if (path === "/api/auth/sign-out") return Response.json({ success: true });
      if (path === "/api/auth/get-session") return Response.json({});
      throw new Error(`Unexpected fixture route ${path}`);
    },
  });

  await client.signIn();
  await assert.rejects(client.signOut(), /did not return a logged-out session/);
});

test("revocation probes the native model route and actual MCP search call through the stage router", async () => {
  for (const probe of [
    { client: "claude" as const, model: "claude-sonnet-4-6", path: "/v1/messages" },
    { client: "codex" as const, model: "gpt-5.4", path: "/v1/responses" },
  ]) {
    const seen: string[] = [];
    const client = new PreviewClient(config, {
      stageRouter: {
        fetch: async (input, init) => {
          const url = new URL(input.toString());
          assert.equal(url.origin, origin);
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("cookie"), null);
          assert.equal(headers.get("origin"), null);
          seen.push(url.pathname);
          if (url.pathname === probe.path) {
            assert.equal(init?.method, "POST");
            assert.equal(headers.get(probe.client === "claude" ? "authorization" : "x-api-key"),
              probe.client === "claude" ? `Bearer ${credentials.modelKey}` : credentials.modelKey);
            assert.equal(headers.get(probe.client === "claude" ? "x-api-key" : "authorization"), null);
            const body = JSON.parse(String(init?.body));
            assert.equal(body.model, probe.model);
            if (probe.client === "claude") {
              assert.deepEqual(body, {
                model: probe.model,
                max_tokens: 8,
                messages: [{ role: "user", content: "Reply with exactly OK." }],
              });
            } else {
              assert.deepEqual(body, { model: probe.model, input: "Reply with exactly OK.", max_output_tokens: 8 });
            }
            return new Response("private model denial", { status: 403 });
          }
          assert.equal(url.pathname, "/mcp");
          assert.equal(init?.method, "POST");
          assert.equal(headers.get("authorization"), `Bearer ${credentials.toolsToken}`);
          assert.deepEqual(JSON.parse(String(init?.body)), {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "search", arguments: { query: "pool", limit: 1 } },
          });
          return new Response(null, { status: 401 });
        },
      },
    });

    await client.verifyRevoked(credentials, probe);
    assert.deepEqual(seen.sort(), ["/mcp", probe.path].sort());
  }
});

test("revocation does not accept a successful model request", async () => {
  const client = new PreviewClient(config, {
    fetch: async (input) => new URL(input.toString()).pathname === "/v1/responses"
      ? Response.json({ status: "completed" })
      : new Response(null, { status: 401 }),
  });
  await assert.rejects(client.verifyRevoked(credentials, { client: "codex", model: "gpt-5.4" }),
    /Revoked model credential returned HTTP 200/);
});
