import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { slackCatalogEntry } from "./catalog.mjs";

const person = (id) => ({
  id: id === "owner" ? "U_SYNTHETIC_OWNER" : "U_SYNTHETIC_MEMBER",
  name: id === "owner" ? "Synthetic Owner" : "Synthetic Member",
  token: `xoxp-synthetic-${id}`,
  bot: `xoxb-synthetic-${id}`,
  message: `synthetic_${id}_history`,
});

const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
};

const output = (response, status, value, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(value));
};

function localSwagger(spec, origin) {
  const local = structuredClone(spec);
  assert.equal(local.swagger, "2.0", "Slack must keep its maintained Swagger 2.0 document");
  assert.equal(local.host, "slack.com", "The captured vendor spec host changed");
  assert.equal(local.basePath, "/api", "The captured vendor spec basePath changed");
  local.host = new URL(origin).host;
  local.schemes = ["http"];
  return local;
}

/** The fixture serves the maintained catalog package and Slack's local OAuth/API endpoints. */
export async function startSlackMock({ directory, source, vendorSpec, userScope, authorizationPath, tokenPath }) {
  const oauth = new Map();
  const codes = new Map();
  const requests = { authorization: [], exchanges: [], api: [], catalog: [], approvals: [] };
  let appSource;
  let swagger;
  let origin;
  let sequence = 0;
  let stopPromise;
  const catalogEntry = slackCatalogEntry(source);
  const official = { version: 1, apps: [catalogEntry] };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      const path = url.pathname;
      if (request.method === "GET" && path === "/catalog/index.json") {
        const result = await handleCatalog(new Request(url.href), async () =>
          new Response(JSON.stringify(official), { status: 200, headers: { "content-type": "application/json" } }),
          { google: false, github: false, slack: true },
        );
        const payload = await result.arrayBuffer();
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(payload));
        return;
      }
      if (request.method === "GET" && path === "/catalog/apps/slack.json") {
        requests.catalog.push({ path, package: appSource?.package });
        if (!appSource) return output(response, 503, { error: "Slack fixture is not ready" });
        return output(response, 200, appSource);
      }
      if (request.method === "GET" && path === "/catalog/specs/slack-openapi.json") {
        requests.catalog.push({ path, package: appSource?.package });
        if (!swagger) return output(response, 503, { error: "Slack OpenAPI fixture is not ready" });
        return output(response, 200, swagger);
      }
      if (request.method === "GET" && path === authorizationPath) {
        const scope = url.searchParams.get("scope");
        const userScopes = url.searchParams.get("user_scope");
        const state = url.searchParams.get("state");
        const redirectUri = url.searchParams.get("redirect_uri");
        const clientId = url.searchParams.get("client_id");
        assert.ok(state && redirectUri && clientId, "Slack authorization request is incomplete");
        assert.equal(url.searchParams.get("response_type"), "code");
        assert.equal(clientId, "synthetic-slack-rest-client");
        assert.ok(scope === null || scope === "", "Slack user sign-in must not request bot scope");
        assert.equal(userScopes, userScope, "Slack user_scope must match the maintained client exactly");
        oauth.set(state, { redirectUri, userScope: userScopes, clientId });
        requests.authorization.push({
          scope,
          userScope: userScopes,
          clientId,
          redirectOrigin: new URL(redirectUri).origin,
          redirectPath: new URL(redirectUri).pathname,
        });
        const buttons = ["owner", "member"].map((id) =>
          `<a role="button" href="${origin}/oauth/approve?state=${encodeURIComponent(state)}&actor=${id}">Connect as ${person(id).name}</a>`,
        ).join("\n");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(`<!doctype html><html><head><title>Slack authorization</title></head><body><main><h1>Connect Slack</h1><p>Synthetic workspace: Example team</p><p>User token permissions: ${userScope}</p>${buttons}</main></body></html>`);
        return;
      }
      if (request.method === "GET" && path === "/oauth/approve") {
        const state = url.searchParams.get("state") ?? "";
        const actor = url.searchParams.get("actor") ?? "owner";
        const pending = oauth.get(state);
        assert.ok(pending, "Slack authorization state was not issued by this mock");
        assert.ok(actor === "owner" || actor === "member", "Unknown synthetic Slack person");
        const code = `synthetic-code-${actor}-${++sequence}`;
        codes.set(code, { actor, redirectUri: pending.redirectUri, state });
        const callback = new URL(pending.redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        requests.approvals.push({ actor, codeIssued: true });
        response.writeHead(302, { location: callback.href, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "POST" && path === tokenPath) {
        const form = await bodyOf(request);
        const issued = codes.get(String(form.code ?? ""));
        assert.ok(issued, "Slack token exchange used an unknown code");
        const { actor } = issued;
        assert.equal(form.grant_type, "authorization_code");
        assert.equal(form.redirect_uri, issued.redirectUri);
        assert.equal(form.client_id, "synthetic-slack-rest-client");
        assert.equal(form.client_secret, "synthetic-slack-rest-secret");
        assert.equal(request.headers.authorization, undefined, "Slack client_secret_post must not send Basic auth");
        requests.exchanges.push({ actor, grantType: form.grant_type, clientAuth: "client_secret_post" });
        const user = person(actor);
        return output(response, 200, {
          ok: true,
          app_id: "A_SYNTHETIC_SLACK_APP",
          access_token: user.bot,
          scope: "app_mentions:read",
          token_type: "bot",
          team: { id: "T_SYNTHETIC", name: "Example team" },
          authed_user: {
            id: user.id,
            access_token: user.token,
            scope: userScope,
            token_type: "user",
          },
        });
      }
      if (path.startsWith("/api/")) {
        const auth = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1];
        const actor = ["owner", "member"].find((id) => person(id).token === auth);
        const operation = path.slice("/api/".length);
        const data = ["GET", "HEAD"].includes(request.method) ? {} : await bodyOf(request);
        const channel = String(data.channel ?? url.searchParams.get("channel") ?? "");
        const record = { operation, method: request.method, actor: actor ?? null, authKind: auth?.startsWith("xoxb-") ? "bot" : auth?.startsWith("xoxp-") ? "user" : "missing" };
        requests.api.push(record);
        if (!actor) return output(response, 401, { ok: false, error: "invalid_auth" });
        const user = person(actor);
        if (operation === "auth.test")
          return output(response, 200, { ok: true, user_id: user.id, user: user.name, team_id: "T_SYNTHETIC", team: "Example team", url: "https://example.test/" });
        if (operation === "conversations.history") {
          if (channel !== "C_SYNTHETIC") return output(response, 200, { ok: false, error: "channel_not_found" });
          return output(response, 200, {
            ok: true,
            channel,
            messages: [{ type: "message", user: user.id, ts: actor === "owner" ? "1.000001" : "2.000002", text: user.message }],
            has_more: false,
            response_metadata: { next_cursor: "" },
          });
        }
        if (operation === "chat.postMessage") {
          if (channel !== "C_SYNTHETIC" || typeof data.text !== "string")
            return output(response, 200, { ok: false, error: "invalid_arguments" });
          return output(response, 200, {
            ok: true,
            channel,
            ts: `3.${++sequence}`,
            message: { type: "message", user: user.id, text: data.text },
          });
        }
        return output(response, 404, { ok: false, error: "unknown_method" });
      }
      return output(response, 404, { error: "not_found" });
    } catch (error) {
      requests.api.push({ operation: "mock-assertion", error: String(error?.message ?? error) });
      return output(response, 400, { error: "synthetic fixture rejected the request" });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    openapiSpecUrl: `${origin}/catalog/specs/slack-openapi.json`,
    authorizationPath,
    tokenPath,
    async loadFixture(localSource) {
      appSource = localSource;
      swagger = localSwagger(vendorSpec, origin);
      const specPath = join(directory, "slack-openapi-local.json");
      await writeFile(specPath, JSON.stringify(swagger), { mode: 0o600 });
      return specPath;
    },
    async approveWithoutBrowser(authorizationUrl, actor) {
      const authorization = new URL(authorizationUrl);
      assert.equal(authorization.origin, origin, "Synthetic Slack consent must stay on the local mock");
      assert.equal(authorization.pathname, authorizationPath, "Synthetic Slack consent used the wrong authorization path");
      const consent = await fetch(authorization, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      assert.equal(consent.status, 200, "Synthetic Slack authorization should show consent before approval");
      await consent.arrayBuffer();
      const approve = new URL("/oauth/approve", origin);
      approve.searchParams.set("state", authorization.searchParams.get("state") ?? "");
      approve.searchParams.set("actor", actor);
      const response = await fetch(approve, { redirect: "manual" });
      assert.equal(response.status, 302, "Synthetic Slack consent should redirect to the host callback");
      const callbackUrl = response.headers.get("location");
      assert.ok(callbackUrl, "Synthetic Slack consent did not return a callback URL");
      return callbackUrl;
    },
    observations: () => structuredClone(requests),
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
        server.closeAllConnections();
      }).then(() => writeFile(
        join(directory, "slack-mock-observations.json"),
        JSON.stringify(requests, null, 2),
        { mode: 0o600 },
      ));
      return stopPromise;
    },
  };
}
