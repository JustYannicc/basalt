import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { URL } from "node:url";

export const gitlabHostedClient = {
  id: "synthetic-gitlab-hosted-client",
  secret: "synthetic-gitlab-hosted-secret",
};

const instanceClients = {
  legacy: { clientId: "synthetic-gitlab-legacy-client", clientSecret: "synthetic-gitlab-legacy-secret" },
  "instance-a": {
    clientId: "synthetic-gitlab-instance-a-client",
    clientSecret: "synthetic-gitlab-instance-a-secret",
  },
  "instance-b": {
    clientId: "synthetic-gitlab-instance-b-client",
    clientSecret: "synthetic-gitlab-instance-b-secret",
  },
};

const json = (response, status, value, headers = {}) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("application/json")
    ? JSON.parse(raw || "{}")
    : Object.fromEntries(new URLSearchParams(raw));
};

const scopesOf = (value) => String(value ?? "").split(/\s+/u).filter(Boolean).sort();
const challengeOf = (value) => createHash("sha256").update(value).digest("base64url");

/** Three loopback origins: two approved instances and one private redirect target that stays denied. */
export async function startGitLabFixtures() {
  const observations = [];
  const sites = [];
  const servers = [];
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const patTokens = new Map();
  let sequence = 0;

  const issueTokens = (site, client, flow, generation, response) => {
    const accessToken = "synthetic-gitlab-access-" + site.id + "-" + randomUUID();
    const refreshToken = "synthetic-gitlab-refresh-" + site.id + "-" + randomUUID();
    const expiresIn = generation === 0 ? 1 : 3600;
    const grant = {
      siteId: site.id,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: flow.redirectUri,
      generation,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    accessTokens.set(accessToken, grant);
    refreshTokens.set(refreshToken, grant);
    if (flow.previousAccessToken !== undefined) accessTokens.delete(flow.previousAccessToken);
    if (flow.previousRefreshToken !== undefined) refreshTokens.delete(flow.previousRefreshToken);
    json(response, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      scope: "api read_user",
      expires_in: expiresIn,
    });
    return { accessToken, refreshToken };
  };

  const specification = (site) => ({
    openapi: "3.0.3",
    info: { title: "Synthetic GitLab API", version: "fixture" },
    paths: {
      "/api/v4/projects": {
        get: {
          operationId: "getApiV4Projects",
          tags: ["Projects"],
          summary: "List projects for this synthetic instance",
          security: [{ apiKey: [] }, { http: [] }],
          responses: {
            "200": {
              description: "Projects",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        name: { type: "string" },
                        path_with_namespace: { type: "string" },
                        web_url: { type: "string", format: "uri" },
                      },
                      required: ["id", "name", "path_with_namespace", "web_url"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "PRIVATE-TOKEN" },
        http: { type: "http", scheme: "bearer" },
      },
    },
    servers: [{ url: site.origin }],
  });

  const startSite = async (id) => {
    const site = { id, origin: undefined, host: undefined, redirectHealthTo: undefined, requests: [] };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", site.origin ?? "http://fixture.invalid");
      const pathname = url.pathname;
      const baseEvent = {
        site: site.id,
        host: String(request.headers.host ?? "").toLowerCase(),
        method: request.method ?? "GET",
        path: pathname,
      };
      site.requests.push(baseEvent);

      if (request.method === "GET" &&
        pathname === "/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v3.yaml") {
        observations.push({ ...baseEvent, phase: "specification" });
        return json(response, 200, specification(site));
      }

      if (request.method === "GET" && pathname === "/oauth/authorize") {
        const client = instanceClients[site.id];
        const suppliedId = url.searchParams.get("client_id");
        const state = url.searchParams.get("state") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const scopes = scopesOf(url.searchParams.get("scope"));
        const valid = client !== undefined &&
          suppliedId === client.clientId &&
          state !== "" &&
          redirectUri !== "" &&
          codeChallenge !== "" &&
          url.searchParams.get("code_challenge_method") === "S256" &&
          url.searchParams.get("response_type") === "code" &&
          JSON.stringify(scopes) === JSON.stringify(["api", "read_user"]);
        observations.push({
          ...baseEvent,
          phase: "authorization",
          clientId: suppliedId,
          sharedClientAttempt: suppliedId === gitlabHostedClient.id,
          valid,
        });
        if (!valid) return json(response, 400, { error: "invalid_request" });
        const code = "synthetic-gitlab-code-" + randomUUID();
        codes.set(code, {
          siteId: site.id,
          clientId: client.clientId,
          redirectUri,
          codeChallenge,
          state,
        });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        response.writeHead(302, { location: callback.href, "cache-control": "no-store" });
        return response.end();
      }

      if (request.method === "POST" && pathname === "/oauth/token") {
        const payload = await readBody(request);
        const client = instanceClients[site.id];
        const suppliedId = String(payload.client_id ?? "");
        const secretSupplied = Object.hasOwn(payload, "client_secret");
        const secretMatches = client !== undefined &&
          suppliedId === client.clientId &&
          payload.client_secret === client.clientSecret;
        const event = {
          ...baseEvent,
          phase: payload.grant_type === "refresh_token" ? "token_refresh" : "token_exchange",
          grantType: String(payload.grant_type ?? ""),
          clientId: suppliedId,
          clientSecretSupplied: secretSupplied,
          clientSecretMatches: secretMatches,
          sharedClientAttempt: suppliedId === gitlabHostedClient.id ||
            payload.client_secret === gitlabHostedClient.secret,
          contentType: String(request.headers["content-type"] ?? "").toLowerCase(),
          authorizationHeaderPresent: request.headers.authorization !== undefined,
        };
        observations.push(event);
        if (!secretMatches || event.authorizationHeaderPresent)
          return json(response, 401, { error: "invalid_client" });

        if (payload.grant_type === "authorization_code") {
          const code = codes.get(String(payload.code ?? ""));
          const verifierMatches = code !== undefined &&
            challengeOf(String(payload.code_verifier ?? "")) === code.codeChallenge;
          const redirectMatches = code !== undefined && payload.redirect_uri === code.redirectUri;
          if (!code || code.siteId !== site.id || code.clientId !== suppliedId ||
            !verifierMatches || !redirectMatches) {
            observations.push({ ...baseEvent, phase: "rejected_token_exchange" });
            return json(response, 400, { error: "invalid_grant" });
          }
          codes.delete(String(payload.code));
          event.pkceVerifierMatched = verifierMatches;
          event.redirectUriMatched = redirectMatches;
          issueTokens(site, client, { redirectUri: code.redirectUri }, 0, response);
          return;
        }

        if (payload.grant_type === "refresh_token") {
          const refreshToken = String(payload.refresh_token ?? "");
          const prior = refreshTokens.get(refreshToken);
          if (!prior || prior.siteId !== site.id || prior.clientId !== suppliedId ||
            prior.clientSecret !== payload.client_secret) {
            observations.push({ ...baseEvent, phase: "rejected_token_refresh" });
            return json(response, 400, { error: "invalid_grant" });
          }
          event.refreshTokenSiteMatches = prior.siteId === site.id;
          event.redirectUriMatched = payload.redirect_uri === prior.redirectUri;
          const rotated = issueTokens(site, client, {
            redirectUri: prior.redirectUri,
            previousAccessToken: [...accessTokens.entries()]
              .find(([, value]) => value === prior)?.[0],
            previousRefreshToken: refreshToken,
          }, prior.generation + 1, response);
          event.rotated = rotated.refreshToken !== refreshToken;
          return;
        }

        return json(response, 400, { error: "unsupported_grant_type" });
      }

      const bearer = String(request.headers.authorization ?? "").match(/^Bearer\s+(.+)$/iu)?.[1];
      const privateToken = request.headers["private-token"];
      const oauthGrant = bearer === undefined ? undefined : accessTokens.get(bearer);
      const patSite = typeof privateToken === "string"
        ? patTokens.get(privateToken)
        : undefined;
      const credentialSite = oauthGrant?.siteId ?? patSite;
      const authenticated = credentialSite === site.id &&
        (oauthGrant === undefined || oauthGrant.expiresAt > Date.now());
      observations.push({
        ...baseEvent,
        phase: pathname === "/api/v4/user" ? "health" : "api",
        authKind: oauthGrant === undefined ? (patSite === undefined ? "none" : "pat") : "oauth",
        credentialPresent: oauthGrant !== undefined || patSite !== undefined,
        credentialSiteMatches: credentialSite === site.id,
        credentialActive: authenticated,
      });

      if (request.method === "GET" && pathname === "/api/v4/user" && site.redirectHealthTo) {
        response.writeHead(302, { location: site.redirectHealthTo, "cache-control": "no-store" });
        return response.end();
      }
      if (!authenticated) return json(response, 401, { error: "invalid_token" });
      if (request.method === "GET" && pathname === "/api/v4/user") {
        const number = site.id === "instance-a" ? 4101 : site.id === "instance-b" ? 4202 : 4303;
        return json(response, 200, {
          id: number,
          username: "fixture_" + site.id,
          web_url: site.origin + "/fixture_" + site.id,
        });
      }
      if (request.method === "GET" && pathname === "/api/v4/projects") {
        const marker = "synthetic_gitlab_" + site.id + "_project";
        return json(response, 200, [{
          id: site.id === "instance-a" ? 5101 : site.id === "instance-b" ? 5202 : 5303,
          name: marker,
          path_with_namespace: "fixture/" + site.id + "/" + marker,
          web_url: site.origin + "/fixture/" + site.id + "/" + marker,
        }]);
      }
      return json(response, 404, { error: "unmocked synthetic GitLab route" });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object", "GitLab fixture must expose a TCP port");
    site.origin = "http://127.0.0.1:" + address.port;
    site.host = new URL(site.origin).host;
    if (Object.hasOwn(instanceClients, site.id)) {
      site.client = instanceClients[site.id];
      site.patToken = "synthetic-gitlab-pat-" + site.id;
      patTokens.set(site.patToken, site.id);
    }
    servers.push(server);
    sites.push(site);
    return site;
  };

  await startSite("instance-a");
  await startSite("instance-b");
  await startSite("unapproved");
  await startSite("legacy");
  return {
    sites,
    site(id) {
      const site = sites.find((candidate) => candidate.id === id);
      assert.ok(site, "Unknown synthetic GitLab site: " + id);
      return site;
    },
    observations,
    async stop() {
      await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      })));
    },
  };
}
