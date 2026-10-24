import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const actors = [
  {
    role: "member",
    email: "zoho-member@example.test",
    marker: "zoho_native_member_7f52",
    authorizationCode: "synthetic-zoho-code-member",
    accessToken: "synthetic-zoho-access-member",
    refreshToken: "synthetic-zoho-refresh-member",
  },
  {
    role: "admin",
    email: "zoho-admin@example.test",
    marker: "zoho_native_admin_19c4",
    authorizationCode: "synthetic-zoho-code-admin",
    accessToken: "synthetic-zoho-access-admin",
    refreshToken: "synthetic-zoho-refresh-admin",
  },
];

const escapeHtml = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const readBody = async request => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("Synthetic provider request body exceeded its bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const bodyValues = (contentType, text) => {
  if (contentType?.includes("application/json")) {
    const parsed = JSON.parse(text || "{}");
    return new Map(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }
  return new Map(new URLSearchParams(text));
};

const sendJson = (response, status, value) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

function matchingScopes(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && expected.every(scope => value.includes(scope));
}

/** A loopback-only OAuth and CRM fixture; persisted events never contain tokens, codes, or bodies. */
export async function startZohoProvider({ clientId, clientSecret, scopes }) {
  assert.ok(clientId && clientSecret, "Synthetic Zoho client credentials are required");
  const byCode = new Map(actors.map(actor => [actor.authorizationCode, actor]));
  const byToken = new Map(actors.map(actor => [actor.accessToken, actor]));
  const events = [];
  let origin = "";
  const record = event => {
    if (events.length >= 128) throw new Error("Synthetic Zoho provider request bound exceeded");
    events.push({ ordinal: events.length + 1, ...event });
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/oauth/v2/auth" && request.method === "GET") {
        const requestedScopes = (url.searchParams.get("scope") ?? "").split(",").filter(Boolean);
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        let redirect;
        try { redirect = new URL(redirectUri); } catch { redirect = undefined; }
        const valid = url.searchParams.get("client_id") === clientId
          && url.searchParams.get("response_type") === "code"
          && url.searchParams.get("access_type") === "offline"
          && url.searchParams.get("prompt") === "consent"
          && Boolean(url.searchParams.get("state"))
          && redirect?.protocol === "http:"
          && redirect.hostname === "127.0.0.1"
          && matchingScopes(requestedScopes, scopes);
        record({
          kind: "oauth_authorize",
          method: request.method,
          path: url.pathname,
          status: valid ? 200 : 400,
          clientIdMatches: url.searchParams.get("client_id") === clientId,
          loopbackRedirect: redirect?.hostname === "127.0.0.1",
          accessTypeOffline: url.searchParams.get("access_type") === "offline",
          promptConsent: url.searchParams.get("prompt") === "consent",
          requestedScopeCount: requestedScopes.length,
          requestedScopesMatch: matchingScopes(requestedScopes, scopes),
          statePresent: Boolean(url.searchParams.get("state")),
        });
        if (!valid) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          response.end("Synthetic Zoho authorization request did not match the fixture contract.");
          return;
        }
        const links = actors.map(actor => {
          const callback = new URL(redirectUri);
          callback.searchParams.set("code", actor.authorizationCode);
          callback.searchParams.set("state", url.searchParams.get("state"));
          return "<p><a href=\"" + escapeHtml(callback.href) + "\">"
            + escapeHtml(actor.email) + "</a></p>";
        }).join("");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
        });
        response.end("<!doctype html><html><body><h1>Synthetic Zoho sign in</h1>" + links + "</body></html>");
        return;
      }

      if (url.pathname === "/oauth/v2/token" && request.method === "POST") {
        const text = await readBody(request);
        const values = bodyValues(request.headers["content-type"], text);
        let submittedClientId = values.get("client_id");
        let submittedClientSecret = values.get("client_secret");
        const basic = request.headers.authorization;
        if ((!submittedClientId || !submittedClientSecret) && basic?.startsWith("Basic ")) {
          const decoded = Buffer.from(basic.slice("Basic ".length), "base64").toString("utf8");
          const separator = decoded.indexOf(":");
          if (separator >= 0) {
            submittedClientId = decoded.slice(0, separator);
            submittedClientSecret = decoded.slice(separator + 1);
          }
        }
        const code = values.get("code") ?? "";
        const person = byCode.get(code);
        const valid = submittedClientId === clientId
          && submittedClientSecret === clientSecret
          && values.get("grant_type") === "authorization_code"
          && person !== undefined;
        record({
          kind: "oauth_token",
          method: request.method,
          path: url.pathname,
          status: valid ? 200 : 400,
          clientIdMatches: submittedClientId === clientId,
          clientSecretMatches: submittedClientSecret === clientSecret,
          authorizationCodeGrant: values.get("grant_type") === "authorization_code",
          actor: person?.role ?? null,
        });
        if (!valid) {
          sendJson(response, 400, { error: "invalid_client" });
          return;
        }
        sendJson(response, 200, {
          access_token: person.accessToken,
          refresh_token: person.refreshToken,
          token_type: "Zoho-oauthtoken",
          expires_in: 3600,
          expires_in_sec: 3600,
          scope: scopes.join(","),
          api_domain: origin,
        });
        return;
      }

      if (url.pathname.startsWith("/crm/v8/")) {
        const authorization = request.headers.authorization ?? "";
        const separator = authorization.indexOf(" ");
        const scheme = separator < 0 ? authorization : authorization.slice(0, separator);
        const token = separator < 0 ? "" : authorization.slice(separator + 1);
        const person = byToken.get(token);
        const apiPath = url.pathname.slice("/crm/v8".length);
        let status = 200;
        if (request.method !== "GET" || scheme !== "Zoho-oauthtoken" || !person) status = 401;
        else if (apiPath !== "/org" && apiPath !== "/Leads") status = 404;
        const event = {
          kind: "crm",
          method: request.method,
          path: url.pathname,
          status,
          actor: person?.role ?? null,
          authorizationScheme: scheme || null,
          module: apiPath === "/Leads" ? "Leads" : undefined,
          fields: url.searchParams.get("fields") ?? undefined,
        };
        record(event);
        if (status !== 200) {
          sendJson(response, status, { code: "INVALID_DATA", message: "Synthetic Zoho request denied" });
          return;
        }
        if (apiPath === "/org") {
          sendJson(response, 200, {
            org: [{ id: "synthetic-eu-org-001", company_name: "Synthetic Shared CRM" }],
          });
          return;
        }
        sendJson(response, 200, {
          data: [{
            id: person.role === "member" ? "900000000000010001" : "900000000000010002",
            Last_Name: person.marker,
          }],
          info: {
            page: 1,
            per_page: 200,
            count: 1,
            more_records: false,
            sort_by: "id",
            sort_order: "asc",
            next_page_token: null,
            previous_page_token: null,
            page_token_expiry: null,
          },
        });
        return;
      }

      record({
        kind: "unexpected",
        method: request.method ?? "UNKNOWN",
        path: url.pathname,
        status: 404,
      });
      sendJson(response, 404, { code: "NOT_FOUND", message: "Synthetic Zoho fixture has no such endpoint" });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "synthetic_fixture_error" });
      else response.destroy();
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object", "Synthetic Zoho fixture did not bind a TCP port");
  origin = "http://127.0.0.1:" + address.port;
  return {
    origin,
    actors: actors.map(({ role, email, marker }) => ({ role, email, marker })),
    privateValues: actors.flatMap(actor => [actor.authorizationCode, actor.accessToken, actor.refreshToken]),
    events: () => events.map(event => ({ ...event })),
    apiRequests: () => events.filter(event => event.kind === "crm").map(event => ({ ...event })),
    stop: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
