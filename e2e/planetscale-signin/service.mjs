import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

export const serviceToken = "synthetic-token-id:synthetic-token-secret";
export const hostedClient = { id: "synthetic-hosted-client", secret: "synthetic-hosted-secret" };
const registeredClient = { id: "synthetic_dcr_client", secret: "synthetic_dcr_secret" };

/**
 * PlanetScale's dynamic registration response, sanitized from a real scratch registration: it
 * returns this fixed scope set whatever the request asked for.
 */
export const registrationDefault = [
  "email",
  "openid",
  "profile",
  "database:manage_passwords",
  "database:manage_production_branch_passwords",
  "database:manage_read_only_passwords",
  "database:manage_production_read_only_passwords",
  "database:read_branches",
  "database:read_database",
  "database:read_deploy_requests",
  "organization:create_databases",
  "organization:manage_passwords",
  "organization:manage_production_branch_passwords",
  "organization:manage_read_only_passwords",
  "organization:manage_production_read_only_passwords",
  "organization:read_audit_logs",
  "organization:read_branches",
  "organization:read_databases",
  "organization:read_invoices",
  "organization:read_organization",
  "organization:read_payment_method",
  "organization:write_payment_method",
  "user:read_organizations",
  "user:read_user",
  "read_databases",
  "read_organization",
  "read_organizations",
  "read_user",
];

// Generated from the same current official document used by the scope table. These real routes
// let the installed-app proof resolve every pre-change tool name without contacting PlanetScale.
const operations = JSON.parse(
  readFileSync(new URL("./legacy-operations.json", import.meta.url), "utf8"),
);

const json = (response, body, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const read = async (request) => {
  let value = "";
  for await (const chunk of request) value += chunk;
  return value;
};
const escape = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const pattern = (path) => new RegExp(`^/v1${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);

/**
 * PlanetScale's API, authorization server and documentation on one loopback origin. `dcr`
 * advertises registration; otherwise only a pre-registered (hosted) client can sign in.
 */
export async function startPlanetScale({ dcr, advertised, omitGrantedScope = false, refuseScope }) {
  const calls = [];
  const failures = [];
  const codes = new Map();
  const tokens = new Map();
  let origin;
  const document = () => ({
    openapi: "3.0.1",
    info: { title: "PlanetScale fixture", version: "v1" },
    servers: [{ url: `${origin}/v1` }],
    security: [{ oauth2: [] }],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/oauth/token`,
              scopes: {},
            },
          },
        },
      },
    },
    paths: operations.reduce((paths, { operationId, namespace, method, path }) => {
      const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
      paths[path] = {
        ...paths[path],
        [method]: {
          operationId,
          tags: [namespace],
          parameters,
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      };
      return paths;
    }, {}),
  });
  const clients = () => (dcr ? [hostedClient, registeredClient] : [hostedClient]);
  const handle = async (request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === "/docs/openapi.yaml") return json(response, document());
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, { error: "not_found" }, 404);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        ...(dcr ? { registration_endpoint: `${origin}/oauth/registration` } : {}),
        scopes_supported: advertised,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === "/oauth/registration" && request.method === "POST") {
      assert.ok(dcr, "Registration must not be attempted where a hosted client is configured");
      const input = JSON.parse(await read(request));
      calls.push({ phase: "register", scope: input.scope ?? null });
      return json(
        response,
        {
          client_name: input.client_name,
          client_id: registeredClient.id,
          client_secret: registeredClient.secret,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: "client_secret_basic",
          response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"],
          scope: registrationDefault.join(" "),
          application_type: "web",
        },
        201,
      );
    }
    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      const params = Object.fromEntries(url.searchParams);
      const scope = params.scope ?? "";
      calls.push({ phase: "authorize", client: params.client_id, scope });
      if (!clients().some((client) => client.id === params.client_id))
        return json(response, { error: "invalid_client" }, 401);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(`<!doctype html><title>PlanetScale</title><h1>PlanetScale test authorization</h1>
<form method="post" action="/oauth/authorize/approve">${Object.entries(params)
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`,
        )
        .join("")}<button>Authorize</button></form>`);
    }
    if (url.pathname === "/oauth/authorize/approve" && request.method === "POST") {
      const params = Object.fromEntries(new URLSearchParams(await read(request)));
      // Doorkeeper grants the requested scopes, or the client's registered default for none.
      const granted =
        params.scope === undefined || params.scope.trim() === ""
          ? registrationDefault.join(" ")
          : params.scope;
      const code = randomBytes(16).toString("hex");
      codes.set(code, { ...params, granted });
      const callback = new URL(params.redirect_uri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", params.state);
      callback.searchParams.set("iss", origin);
      response.writeHead(302, { location: callback.href });
      return response.end();
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const body = Object.fromEntries(new URLSearchParams(await read(request)));
      const basic = request.headers.authorization?.match(/^Basic (.+)$/)?.[1];
      // Doorkeeper compares Basic credentials literally.
      const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
      const client = clients().find((entry) => entry.id === id && entry.secret === secret);
      calls.push({
        phase: "token",
        grant: body.grant_type,
        client: id,
        basic: basic !== undefined,
      });
      if (client === undefined) return json(response, { error: "invalid_client" }, 401);
      const grant =
        body.grant_type === "authorization_code"
          ? codes.get(body.code)
          : [...tokens.values()].find((entry) => entry.refresh === body.refresh_token);
      if (grant === undefined || grant.client_id !== client.id)
        return json(response, { error: "invalid_grant" }, 400);
      if (
        body.grant_type === "authorization_code" &&
        createHash("sha256")
          .update(body.code_verifier ?? "")
          .digest("base64url") !== grant.code_challenge
      )
        return json(response, { error: "invalid_grant" }, 400);
      codes.delete(body.code);
      const access = `pscale_oauth_${randomBytes(12).toString("hex")}`;
      const refresh = `pscale_refresh_${randomBytes(12).toString("hex")}`;
      tokens.set(access, { ...grant, refresh });
      const granted = grant.granted.split(/\s+/u).filter((scope) => scope !== refuseScope);
      if (refuseScope !== undefined)
        assert.ok(granted.length < grant.granted.split(/\s+/u).length, `Requested ${refuseScope}`);
      return json(response, {
        access_token: access,
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: refresh,
        ...(omitGrantedScope ? {} : { scope: granted.join(" ") }),
        created_at: Math.floor(Date.now() / 1000),
      });
    }
    if (url.pathname.startsWith("/v1/")) {
      const authorization = request.headers.authorization ?? "";
      const oauth = tokens.get(authorization.replace(/^Bearer /, ""));
      const credential =
        authorization === serviceToken
          ? "token"
          : oauth !== undefined && authorization.startsWith("Bearer ")
            ? "oauth"
            : undefined;
      const operation = operations.find(
        (candidate) =>
          candidate.method === request.method.toLowerCase() &&
          pattern(candidate.path).test(url.pathname),
      );
      calls.push({
        phase: "api",
        operation: operation?.operationId ?? url.pathname,
        credential: credential ?? "none",
      });
      if (credential === undefined) return json(response, { code: "unauthorized" }, 401);
      if (operation === undefined) return json(response, { code: "not_found" }, 404);
      if (operation.operationId === "list_organizations")
        return json(response, { data: [{ id: "org_synthetic", name: "acme" }] });
      return json(response, { operation: operation.operationId, credential });
    }
    failures.push(`${request.method} ${url.pathname}`);
    return json(response, { error: "unexpected" }, 404);
  };
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      failures.push(String(error?.message ?? error));
      json(response, { error: "fixture_failed" }, 500);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    calls,
    failures,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
