import { once } from "node:events";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const atlassianPeople = [
  {
    key: "first",
    email: "first@example.test",
    cloudId: "synthetic-cloud-first",
    siteName: "Synthetic first Atlassian site",
    cql: 'text ~ "ATLASSIAN_FIRST_CONFLUENCE_MARKER"',
    pageId: "first-page",
    pageMarker: "ATLASSIAN_FIRST_CONFLUENCE_MARKER",
    issueKey: "FIRST-101",
    jiraMarker: "ATLASSIAN_FIRST_JIRA_MARKER",
  },
  {
    key: "second",
    email: "second@example.test",
    cloudId: "synthetic-cloud-second",
    siteName: "Synthetic second Atlassian site",
    cql: 'text ~ "ATLASSIAN_SECOND_CONFLUENCE_MARKER"',
    pageId: "second-page",
    pageMarker: "ATLASSIAN_SECOND_CONFLUENCE_MARKER",
    issueKey: "SECOND-202",
    jiraMarker: "ATLASSIAN_SECOND_JIRA_MARKER",
  },
];

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
};

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jiraIssue(person, requestedFields) {
  const fields = {
    summary: `${person.siteName} issue`,
    description: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: person.jiraMarker }] }],
    },
    project: { key: person.key === "first" ? "FIRST" : "SECOND", name: person.siteName },
    issuetype: { name: "Task" },
    status: { name: "To Do" },
  };
  const selectedFields = Array.isArray(requestedFields)
    ? Object.fromEntries(requestedFields.filter((name) => name in fields).map((name) => [name, fields[name]]))
    : fields;
  return {
    id: person.key === "first" ? "100101" : "100202",
    key: person.issueKey,
    fields: selectedFields,
  };
}

function confluencePage(person) {
  return {
    id: person.pageId,
    type: "page",
    status: "current",
    title: `${person.siteName} ${person.pageMarker}`,
    space: { key: person.key.toUpperCase(), name: person.siteName },
    body: { storage: { value: `<p>${person.pageMarker}</p>`, representation: "storage" } },
    version: { number: 1 },
  };
}

function confluenceSearchResult(person) {
  return {
    id: person.pageId,
    type: "page",
    status: "current",
    title: `${person.siteName} ${person.pageMarker}`,
    excerpt: person.pageMarker,
    space: { key: person.key.toUpperCase(), name: person.siteName },
    _links: { webui: `/spaces/${person.key.toUpperCase()}/pages/${person.pageId}` },
  };
}

/** Loopback-only Atlassian 3LO and API fixture. It never proxies to Atlassian. */
export async function startAtlassianProvider({ directory, clientId, clientSecret, scopes }) {
  const codes = new Map();
  const tokens = new Map();
  const requests = [];
  const failures = [];
  const reportingRequests = [];
  let nextCode = 0;
  let nextToken = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const log = { method: request.method, path: url.pathname, status: 500, person: null };
    requests.push(log);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        const valid = url.searchParams.get("response_type") === "code"
          && url.searchParams.get("client_id") === clientId
          && url.searchParams.has("redirect_uri")
          && url.searchParams.has("state")
          && url.searchParams.get("audience") === "api.atlassian.com"
          && url.searchParams.get("prompt") === "consent"
          && new Set((url.searchParams.get("scope") ?? "").split(" ")).size === scopes.length;
        if (!valid) {
          log.status = 400;
          return json(response, 400, { error: "invalid authorization request" });
        }
        const fields = ["client_id", "redirect_uri", "state", "scope"];
        const hidden = fields.map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(url.searchParams.get(name) ?? "")}">`).join("");
        const choices = atlassianPeople.map((person) => `<form method="post" action="/authorize/choose">${hidden}<button name="person" value="${person.key}">${person.email}</button></form>`).join("");
        log.status = 200;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><body><h1>Choose a synthetic Atlassian account</h1>${choices}</body></html>`);
        return;
      }

      if (url.pathname === "/authorize/choose" && request.method === "POST") {
        const form = new URLSearchParams(await body(request));
        const person = atlassianPeople.find((item) => item.key === form.get("person"));
        const redirect = new URL(form.get("redirect_uri") ?? "");
        if (!person || form.get("client_id") !== clientId || !form.get("state") || redirect.protocol !== "http:") {
          log.status = 400;
          return json(response, 400, { error: "invalid account choice" });
        }
        const code = `synthetic-code-${++nextCode}`;
        codes.set(code, person);
        log.person = person.key;
        log.status = 302;
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", form.get("state"));
        response.writeHead(302, { location: redirect.href });
        response.end();
        return;
      }

      if (url.pathname === "/oauth/token" && request.method === "POST") {
        const contentType = request.headers["content-type"] ?? "";
        if (!contentType.includes("application/json")) {
          log.status = 415;
          return json(response, 415, { error: "expected JSON token request" });
        }
        const grant = JSON.parse(await body(request));
        if (grant.client_id !== clientId || grant.client_secret !== clientSecret) {
          log.status = 401;
          return json(response, 401, { error: "invalid client" });
        }
        const person = grant.grant_type === "authorization_code" ? codes.get(grant.code) : undefined;
        if (!person) {
          log.status = 400;
          return json(response, 400, { error: "invalid grant" });
        }
        const accessToken = `synthetic-atlassian-access-${++nextToken}`;
        const refreshToken = `synthetic-atlassian-refresh-${nextToken}`;
        tokens.set(accessToken, person);
        if (grant.code) codes.delete(grant.code);
        log.person = person.key;
        log.status = 200;
        return json(response, 200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: scopes.join(" "),
        });
      }

      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      const person = bearer ? tokens.get(bearer) : undefined;
      if (url.pathname === "/oauth/token/accessible-resources" && request.method === "GET") {
        if (!person) {
          log.status = 401;
          return json(response, 401, { error: "unauthorized" });
        }
        log.person = person.key;
        log.status = 200;
        return json(response, 200, [{
          id: person.cloudId,
          url: `https://${person.key}.atlassian.test`,
          name: person.siteName,
          scopes,
        }]);
      }

      if (!person) {
        log.status = 401;
        return json(response, 401, { error: "unauthorized" });
      }

      if (url.pathname === "/me" && request.method === "GET") {
        log.person = person.key;
        log.status = 200;
        return json(response, 200, {
          account_id: `synthetic:${person.key}`,
          name: person.siteName,
          email: person.email,
        });
      }
      if (url.pathname === "/app/report-accounts/" && request.method === "POST") {
        const report = JSON.parse(await body(request));
        if (!Array.isArray(report.accounts) || report.accounts.length < 1 || report.accounts.length > 90)
          throw new Error("Invalid reporting batch");
        for (const account of report.accounts) {
          if (!atlassianPeople.some((candidate) => account.accountId === `synthetic:${candidate.key}`)
            || !Number.isFinite(Date.parse(account.updatedAt)))
            throw new Error("Invalid reported identity or retrieval timestamp");
        }
        reportingRequests.push(report.accounts);
        log.person = person.key;
        log.status = 204;
        response.writeHead(204, { "cycle-period": "7" });
        response.end();
        return;
      }

      const confluence = /^\/ex\/confluence\/([^/]+)\/wiki\/rest\/api\/(content\/search|content\/([^/]+))$/.exec(url.pathname);
      if (confluence && request.method === "GET") {
        if (decodeURIComponent(confluence[1]) !== person.cloudId) {
          log.status = 403;
          return json(response, 403, { message: "site belongs to another account" });
        }
        log.person = person.key;
        log.status = 200;
        if (confluence[2] === "content/search") {
          if (!(url.searchParams.get("cql") ?? "").includes(person.pageMarker)) {
            log.status = 400;
            return json(response, 400, { message: "CQL must name the caller's synthetic page" });
          }
          return json(response, 200, {
            results: [confluenceSearchResult(person)],
            start: 0,
            limit: Number(url.searchParams.get("limit") ?? 10),
            size: 1,
            _links: {},
          });
        }
        if (decodeURIComponent(confluence[3]) !== person.pageId) {
          log.status = 404;
          return json(response, 404, { message: "page not found" });
        }
        return json(response, 200, confluencePage(person));
      }

      const jira = /^\/ex\/jira\/([^/]+)\/rest\/api\/3\/(issue\/([^/]+)|search\/jql)$/.exec(url.pathname);
      if (jira && ["GET", "POST"].includes(request.method ?? "")) {
        if (decodeURIComponent(jira[1]) !== person.cloudId) {
          log.status = 403;
          return json(response, 403, { errorMessages: ["site belongs to another account"] });
        }
        log.person = person.key;
        log.status = 200;
        if (jira[2].startsWith("issue/")) {
          if (request.method !== "GET" || decodeURIComponent(jira[3]) !== person.issueKey) {
            log.status = 404;
            return json(response, 404, { errorMessages: ["issue not found"] });
          }
          return json(response, 200, jiraIssue(person));
        }
        if (request.method !== "POST") {
          log.status = 405;
          return json(response, 405, { errorMessages: ["use POST"] });
        }
        const query = JSON.parse(await body(request));
        if (!(query.jql ?? "").includes(person.jiraMarker)) {
          log.status = 400;
          return json(response, 400, { errorMessages: ["JQL must name the caller's synthetic issue"] });
        }
        return json(response, 200, { issues: [jiraIssue(person, query.fields)], total: 1, isLast: true });
      }

      log.status = 404;
      return json(response, 404, { error: "unsupported synthetic Atlassian endpoint" });
    } catch {
      failures.push({ method: request.method, path: url.pathname, reason: "fixture request failed" });
      log.status = 500;
      return json(response, 500, { error: "synthetic Atlassian fixture failed" });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Atlassian fixture did not bind a loopback port");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    failures,
    reportingRequests,
    apiRequests: () => requests.filter((request) => request.path.startsWith("/ex/")),
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await writeFile(join(directory, "provider.json"), JSON.stringify({ requests, failures }), { mode: 0o600 });
    },
  };
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
