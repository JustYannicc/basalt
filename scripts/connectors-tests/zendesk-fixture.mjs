import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

export const zendeskScopes = Object.freeze(["read", "write"]);
export const marketplaceHeaderNames = Object.freeze([
  "X-Zendesk-Marketplace-Name",
  "X-Zendesk-Marketplace-Organization-Id",
  "X-Zendesk-Marketplace-App-Id",
]);

const json = (response, status, value) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString("utf8");
  if (!value) return {};
  return JSON.parse(value);
};

const s256 = (value) => createHash("sha256").update(value).digest("base64url");
const scopesOf = (value) =>
  String(value ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .sort();

/** Two independent loopback Zendesk sites with OAuth, rotating grants and ticket API records. */
export async function startZendeskFixtures({
  marketplaceHeaders = {},
  tenantPublicClients = false,
  expiresIn = 1,
} = {}) {
  const observations = [];
  const failures = [];
  const servers = [];
  const sites = [];
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const flows = new Map();
  let sequence = 0;
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;

  const clientDefinitions = new Map();
  const tenantCallbacks = new Map();
  const authorizationStatuses = new Map();
  for (const id of ["site-a", "site-b"]) {
    for (const mode of [
      "public",
      "confidential",
      "hosted",
      ...(tenantPublicClients ? ["tenant"] : []),
    ]) {
      const clientId =
        mode === "tenant"
          ? `${id}_zendesk`
          : mode === "hosted"
            ? "zendesk-fixture-client"
            : `synthetic-${id}-${mode}-client`;
      clientDefinitions.set(`${id}:${clientId}`, {
        id,
        mode,
        clientId,
        ...(mode === "public" || mode === "tenant"
          ? {}
          : {
              secret:
                mode === "hosted"
                  ? "zendesk-fixture-secret"
                  : `synthetic-${id}-confidential-secret`,
            }),
      });
    }
  }

  const flowClient = (siteId, mode) => {
    const clientId =
      mode === "hosted" ? "zendesk-fixture-client" : `synthetic-${siteId}-${mode}-client`;
    const value = clientDefinitions.get(`${siteId}:${clientId}`);
    if (!value) throw new Error("Unknown synthetic Zendesk client");
    return mode === "public"
      ? { clientId: value.clientId }
      : { clientId: value.clientId, clientSecret: value.secret };
  };

  const safeFailure = (site, endpoint, reason) => {
    failures.push({ site: site.id, host: site.host, endpoint, reason });
  };

  const record = (site, fields) => {
    observations.push({ site: site.id, host: site.host, ...fields });
  };

  const issueTokens = (site, flow, generation, response) => {
    const accessToken = `synthetic-access-${site.id}-${randomUUID()}`;
    const refreshToken = `synthetic-refresh-${site.id}-${randomUUID()}`;
    const previous = flows.get(flow.id);
    if (previous?.accessToken) accessTokens.delete(previous.accessToken);
    if (previous?.refreshToken) refreshTokens.delete(previous.refreshToken);
    const lifetime = generation === 0 ? expiresIn : 3600;
    const value = {
      ...flow,
      generation,
      accessToken,
      refreshToken,
      expiresAt: now() + lifetime * 1000,
    };
    flows.set(flow.id, value);
    accessTokens.set(accessToken, value);
    refreshTokens.set(refreshToken, value);
    json(response, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      scope: zendeskScopes.join(" "),
      expires_in: lifetime,
    });
  };

  const siteHandler = (site) => {
    return async (request, response) => {
      const endpoint = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      const host = String(request.headers.host ?? "").toLowerCase();
      if (host !== site.host.toLowerCase()) {
        safeFailure(site, endpoint, "unexpected_host");
        return json(response, 421, { error: "invalid_host" });
      }
      const id = site.id;
      try {
        if (request.method === "GET" && endpoint === "/oauth/authorizations/new") {
          const url = new URL(request.url ?? "/", site.origin);
          const refused = authorizationStatuses.get(id);
          if (refused !== undefined) {
            if (refused === 429) response.setHeader("retry-after", "60");
            return json(response, refused, { error: "temporarily_unavailable" });
          }
          const client = [...clientDefinitions.values()].find(
            (candidate) =>
              candidate.id === id && candidate.clientId === url.searchParams.get("client_id"),
          );
          const state = url.searchParams.get("state") ?? "";
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          const challenge = url.searchParams.get("code_challenge") ?? "";
          const scopes = scopesOf(url.searchParams.get("scope"));
          const method = url.searchParams.get("code_challenge_method");
          if (!client && tenantPublicClients)
            return json(response, 400, { error: "invalid_client" });
          if (
            client?.mode === "tenant" &&
            tenantCallbacks.has(id) &&
            redirectUri !== tenantCallbacks.get(id)
          )
            return json(response, 422, { error: "invalid_redirect_uri" });
          if (client?.mode === "tenant" && url.searchParams.get("prompt") !== "consent") {
            // Anonymous preflight sees the sign-in redirect, never consent or a code.
            record(site, {
              phase: "authorization_check",
              clientId: client.clientId,
              cookiePresent: request.headers.cookie !== undefined,
              authHeaderPresent: request.headers.authorization !== undefined,
            });
            response.writeHead(302, { location: `${site.origin}/auth/v2/login` });
            return response.end();
          }
          if (
            !client ||
            client.id !== id ||
            !state ||
            !redirectUri ||
            !challenge ||
            method !== "S256" ||
            url.searchParams.get("response_type") !== "code" ||
            JSON.stringify(scopes) !== JSON.stringify([...zendeskScopes].sort())
          ) {
            safeFailure(site, endpoint, "invalid_authorization_request");
            return json(response, 400, { error: "invalid_request" });
          }
          const flowId = `${id}:${client.mode}:${++sequence}`;
          const flow = {
            id: flowId,
            siteId: id,
            clientId: client.clientId,
            mode: client.mode,
            authMethod:
              client.mode === "public" || client.mode === "tenant" ? "none" : "client_secret_post",
            userId: url.searchParams.get("fixture_user") === "second" ? 9102 : undefined,
          };
          const code = `synthetic-code-${randomUUID()}`;
          codes.set(code, { siteId: id, client, redirectUri, challenge, scopes, flow, state });
          const callback = new URL(redirectUri);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", state);
          record(site, {
            phase: "authorization",
            method: request.method,
            endpoint,
            authMethod: flow.authMethod,
            flowMode: flow.mode,
            scopes,
            pkceMethod: method,
            pkceChallengePresent: true,
            callbackHost: callback.host,
            callbackPath: callback.pathname,
          });
          response.writeHead(302, { location: callback.href, "cache-control": "no-store" });
          return response.end();
        }

        if (request.method === "POST" && endpoint === "/oauth/tokens") {
          const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
          const payload = await readJson(request);
          const client = [...clientDefinitions.values()].find(
            (candidate) =>
              candidate.id === id && candidate.clientId === String(payload.client_id ?? ""),
          );
          if (!client && tenantPublicClients)
            return json(response, 401, { error: "invalid_client" });
          if (
            !contentType.includes("application/json") ||
            !client ||
            client.id !== id ||
            request.headers.authorization !== undefined
          ) {
            safeFailure(site, endpoint, "invalid_token_request");
            return json(response, 400, { error: "invalid_request" });
          }
          const authMethod =
            client.mode === "public" || client.mode === "tenant" ? "none" : "client_secret_post";
          const hasSecret = Object.hasOwn(payload, "client_secret");
          if (
            (authMethod === "none" && hasSecret) ||
            (authMethod !== "none" && payload.client_secret !== client.secret)
          ) {
            safeFailure(site, endpoint, "invalid_client_auth");
            return json(response, 401, { error: "invalid_client" });
          }

          if (payload.grant_type === "authorization_code") {
            const code = codes.get(String(payload.code ?? ""));
            if (
              !code ||
              code.siteId !== id ||
              code.client.clientId !== client.clientId ||
              code.redirectUri !== payload.redirect_uri ||
              s256(String(payload.code_verifier ?? "")) !== code.challenge
            ) {
              safeFailure(site, endpoint, "invalid_code_or_pkce");
              return json(response, 400, { error: "invalid_grant" });
            }
            codes.delete(String(payload.code));
            record(site, {
              phase: "token_exchange",
              method: request.method,
              endpoint,
              authMethod,
              flowMode: code.flow.mode,
              contentType: "application/json",
              grantType: "authorization_code",
              pkceVerifierMatched: true,
              clientSecretInJson: hasSecret,
              basicAuthPresent: false,
            });
            return issueTokens(site, code.flow, 0, response);
          }

          if (payload.grant_type === "refresh_token") {
            const prior = refreshTokens.get(String(payload.refresh_token ?? ""));
            if (!prior || prior.siteId !== id || prior.clientId !== client.clientId) {
              safeFailure(site, endpoint, "invalid_refresh_token");
              return json(response, 400, { error: "invalid_grant" });
            }
            record(site, {
              phase: "token_refresh",
              method: request.method,
              endpoint,
              authMethod,
              flowMode: prior.mode,
              contentType: "application/json",
              grantType: "refresh_token",
              refreshTokenSiteMatches: true,
              clientSecretInJson: hasSecret,
              basicAuthPresent: false,
              rotated: true,
            });
            return issueTokens(site, prior, prior.generation + 1, response);
          }

          safeFailure(site, endpoint, "unsupported_grant");
          return json(response, 400, { error: "unsupported_grant_type" });
        }

        if (endpoint.startsWith("/api/v2/")) {
          const authorization = String(request.headers.authorization ?? "");
          const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
          const owner = accessTokens.get(token ?? "");
          const metadataHeadersMatched = marketplaceHeaderNames.every(
            (name) => request.headers[name.toLowerCase()] === marketplaceHeaders[name],
          );
          const event = {
            phase: "api",
            method: request.method,
            endpoint,
            authMethod: "bearer",
            bearerPresent: token !== undefined,
            credentialSiteMatches: owner?.siteId === id,
            tokenActive: owner !== undefined && owner.expiresAt > now(),
            flowMode: owner?.mode,
            tokenGeneration: owner?.generation,
            marketplaceHeaderNames: [...marketplaceHeaderNames],
            marketplaceHeadersMatched: metadataHeadersMatched,
          };
          record(site, event);
          if (!owner || owner.siteId !== id || owner.expiresAt <= now())
            return json(response, 401, { error: "invalid_token" });
          if (!metadataHeadersMatched) {
            safeFailure(site, endpoint, "marketplace_headers_missing");
            return json(response, 400, { error: "missing_integration_headers" });
          }
          if (
            ["/api/v2/users/me.json", "/api/v2/users/me"].includes(endpoint) &&
            request.method === "GET"
          )
            return json(response, 200, {
              user: {
                id: owner.userId ?? (id === "site-a" ? 9101 : 9202),
                name: `Zendesk fixture ${id}`,
              },
            });
          if (endpoint === "/api/v2/tickets.json" && request.method === "GET") {
            const ticket = {
              id: id === "site-a" ? 7101 : 7202,
              subject: `Synthetic ${id} ticket`,
              status: "open",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            };
            return json(response, 200, { tickets: [ticket] });
          }
          if (/^\/api\/v2\/tickets\/\d+\.json$/.test(endpoint) && request.method === "GET") {
            const ticket = {
              id: Number(endpoint.match(/tickets\/(\d+)/)?.[1]),
              subject: `Synthetic ${id} ticket`,
              status: "open",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            };
            return json(response, 200, { ticket });
          }
          if (
            ["/api/v2/tickets.json", "/api/v2/tickets"].includes(endpoint) &&
            request.method === "POST"
          ) {
            return json(response, 201, {
              ticket: {
                id: id === "site-a" ? 7101 : 7202,
                subject: "Synthetic ticket",
                status: "open",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
            });
          }
          return json(response, 404, { error: "unmocked_route" });
        }

        safeFailure(site, endpoint, "unmocked_route");
        return json(response, 404, { error: "unmocked_route" });
      } catch {
        safeFailure(site, endpoint, "fixture_handler_error");
        return json(response, 400, { error: "invalid_request" });
      }
    };
  };

  const handlersByHost = new Map();
  const server = createServer(async (request, response) => {
    const endpoint = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    const host = String(request.headers.host ?? "").toLowerCase();
    const handler = handlersByHost.get(host);
    if (!handler) {
      failures.push({ site: "unknown", host, endpoint, reason: "unexpected_host" });
      return json(response, 421, { error: "invalid_host" });
    }
    return handler(request, response);
  });

  server.listen(0, "::1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Zendesk fixture did not bind an IPv6 loopback port");
  for (const id of ["site-a", "site-b"]) {
    const hostName = `${id}.localhost`;
    const site = {
      id,
      host: `${hostName}:${address.port}`,
      hostName,
      origin: `http://${hostName}:${address.port}`,
    };
    handlersByHost.set(site.host.toLowerCase(), siteHandler(site));
    sites.push(site);
  }
  servers.push(server);

  return {
    sites,
    site(id) {
      const found = sites.find((site) => site.id === id);
      if (!found) throw new Error("Unknown synthetic Zendesk site");
      return found;
    },
    client: flowClient,
    observations: () => structuredClone(observations),
    failures: () => structuredClone(failures),
    rotations: () =>
      [...flows.values()].map((flow) => ({
        site: flow.siteId,
        mode: flow.mode,
        generation: flow.generation,
        rotated: flow.generation > 0,
      })),
    advanceClock(milliseconds) {
      clockOffset += milliseconds;
    },
    setTenantCallback(siteId, callback) {
      tenantCallbacks.set(siteId, callback);
    },
    setAuthorizationStatus(siteId, status) {
      if (status === undefined) authorizationStatuses.delete(siteId);
      else authorizationStatuses.set(siteId, status);
    },
    removeTenantClient(siteId) {
      clientDefinitions.delete(`${siteId}:${siteId}_zendesk`);
    },
    revokeTenantUser(userId) {
      for (const [token, flow] of accessTokens) {
        if (flow.mode === "tenant" && (flow.userId ?? 9101) === userId) accessTokens.delete(token);
      }
      for (const [token, flow] of refreshTokens) {
        if (flow.mode === "tenant" && (flow.userId ?? 9101) === userId) refreshTokens.delete(token);
      }
    },
    async stop() {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
