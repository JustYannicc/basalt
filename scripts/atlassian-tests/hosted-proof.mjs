import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { atlassianPeople } from "./provider.mjs";
import { proveInstalledClients } from "./native.mjs";

const clientId = "synthetic-atlassian-client";
const clientSecret = "synthetic-atlassian-secret";

const text = (result) => JSON.stringify(result.structuredContent ?? result.content ?? result);
const call = (client, name, args) => client.callTool({ name, arguments: args });

async function mcp(origin, token, Client, Transport) {
  const client = new Client({ name: "atlassian-proof", version: "1" });
  await client.connect(new Transport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

function toolPaths(search) {
  const items = search.structuredContent?.items;
  assert.ok(Array.isArray(items), "Signalbox search did not return catalog tools");
  const find = (name) => items.find((item) => item.path?.endsWith(`.${name}`))?.path;
  const paths = Object.fromEntries(["listSites", "searchConfluence", "readConfluencePage", "getJiraIssue", "searchJiraIssues"]
    .map((name) => [name, find(name)]));
  for (const [name, path] of Object.entries(paths)) assert.ok(path, `Catalog source omitted tool ${name}`);
  return paths;
}

/** Deploy the unmodified catalog app except for provider endpoint and host-placement overrides. */
export const proveHostedAtlassian = ({
  root,
  directory,
  upstream,
  target,
  actors,
  sessionsApi,
  browser,
  callback,
  provider,
  catalogApp,
  oauthDefinition,
  protectedHome,
}) => Effect.gen(function* () {
  let checks = 0;
  const check = (condition, operation) => { checks++; assert.ok(condition, operation); };
  const request = (actor, method, path, data) => sessionsApi.request(actor, method, path, data);
  const checked = (response, status, operation) => {
    if (response.status !== status)
      appendFileSync(join(directory, "responses.jsonl"), `${JSON.stringify({ operation, status: response.status })}\n`, { mode: 0o600 });
    check(response.status === status, operation);
    return response.body;
  };
  const prefix = `/api/organizations/${actors.organization.id}`;
  check(catalogApp.entry.id === "atlassian", "Use catalog app id atlassian");
  check(catalogApp.packageName === "atlassian", "Use the private neutral Atlassian package");
  check(oauthDefinition.id === "atlassian-local-proof", "Use the unique local OAuth client id");

  const packageFile = catalogApp.files.find((file) => file.path === "package.json");
  check(packageFile, "Deploy the captured Atlassian package manifest");
  const manifest = JSON.parse(packageFile.content);
  check(manifest.name === catalogApp.packageName, "Served Atlassian package and manifest names match");
  const servedSdkVersion = manifest.dependencies?.apps;
  check(servedSdkVersion === "0.0.1-beta.104-basalt.1", "Serve the pinned Basalt framework release");
  const frameworkRelease = checked(
    yield* request(actors.owner, "GET", `${prefix}/framework/release`),
    200,
    "Read the actual organization framework release before app deployment",
  );
  check(typeof frameworkRelease.version === "string", "Framework release API returns a version");
  check(frameworkRelease.version === servedSdkVersion,
    "Organization framework release matches the served Atlassian manifest pin");

  const deployed = checked(yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: "Atlassian catalog proof",
    files: catalogApp.files,
  }), 200, "Deploy the Atlassian catalog source");
  const appPath = `${prefix}/apps/${deployed.id}`;
  const access = checked(yield* request(actors.owner, "GET", `${appPath}/access`), 200, "Read app access");
  checked(yield* request(actors.owner, "PATCH", `${appPath}/access`, {
    revision: access.revision,
    audience: { kind: "everyone" },
  }), 200, "Share the one hosted app within the organization");

  const accounts = [];
  const tokens = [];
  for (const [index, actor] of [actors.member, actors.admin].entries()) {
    const person = atlassianPeople[index];
    const connection = checked(yield* request(actor, "POST", `${appPath}/accounts/user/atlassian/connections`, {
      destination: { kind: "personal" },
    }), 200, "Create a personal Atlassian OAuth connection");
    const started = checked(yield* request(actor, "POST", `${prefix}/connections/${connection.id}/oauth/start`, {
      method: "oauth",
      label: `Synthetic ${person.key} Atlassian account`,
    }), 200, "Start the hosted Atlassian OAuth flow");
    const authorization = new URL(started.authorizationUrl);
    check(authorization.origin === provider.origin, "OAuth page stays on the local provider fixture");
    check(started.redirectUri === callback, "Runtime uses the local OAuth callback");
    check(authorization.searchParams.get("client_id") === clientId, "OAuth uses the local hosted client");
    check(authorization.searchParams.get("audience") === "api.atlassian.com", "OAuth preserves Atlassian audience");
    check(authorization.searchParams.get("prompt") === "consent", "OAuth preserves the consent prompt");
    const requestedScopes = new Set((authorization.searchParams.get("scope") ?? "").split(" "));
    check(requestedScopes.size === oauthDefinition.defaultScopes.length
      && oauthDefinition.defaultScopes.every((scope) => requestedScopes.has(scope)),
    "OAuth requests the reviewed Atlassian scopes");

    const callbackUrl = yield* Effect.promise(async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(authorization.href);
        const choice = page.getByRole("button", { name: person.email });
        await choice.waitFor({ state: "visible" });
        await Promise.all([page.waitForURL((url) => url.href.startsWith(callback)), choice.click()]);
        return page.url();
      } finally { await context.close(); }
    });
    const returned = new URL(callbackUrl);
    check(returned.searchParams.get("code"), "Local provider returned an OAuth code");
    check(returned.searchParams.get("state") === authorization.searchParams.get("state"), "OAuth state is preserved");
    const completed = checked(yield* request(actor, "POST", `${prefix}/connections/${connection.id}/oauth/complete`, {
      callbackUrl,
    }), 200, "Exchange the code and save the personal account");
    accounts.push(completed.id);
    const issued = checked(yield* request(actor, "POST", "/api/auth/api-key/create", {
      name: "Atlassian proof",
      metadata: { organization: actors.organization.id },
    }), 200, "Issue an organization-pinned PAT");
    tokens.push(issued.key);
  }
  check(accounts.length === 2 && accounts[0] !== accounts[1], "Save two distinct Atlassian accounts");
  check(actors.organization.id.length > 0, "Both people share one organization");

  const require = createRequire(join(upstream, "package.json"));
  const sdk = yield* Effect.promise(async () => {
    const [client, transport] = await Promise.all([
      import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href),
      import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href),
    ]);
    return { Client: client.Client, StreamableHTTPClientTransport: transport.StreamableHTTPClientTransport };
  });
  const clients = [];
  const mcpOrigin = target.metadata.origin;
  for (const token of tokens) {
    const client = yield* Effect.acquireRelease(Effect.promise(() => mcp(mcpOrigin, token, sdk.Client, sdk.StreamableHTTPClientTransport)),
      (client) => Effect.promise(() => client.close()));
    clients.push(client);
  }

  const found = yield* Effect.promise(() => call(clients[0], "search", { query: deployed.slug }));
  check(!found.isError && text(found).includes("searchConfluence"), "Signalbox MCP finds the actual Atlassian app");
  const paths = toolPaths(found);
  const described = yield* Effect.promise(() => call(clients[0], "describe", { paths: Object.values(paths) }));
  appendFileSync(join(directory, "describe.jsonl"), `${JSON.stringify({
    isError: described.isError,
    result: described.structuredContent ?? described.content,
  })}\n`, { mode: 0o600 });
  check(!described.isError, "Signalbox MCP describes the actual Atlassian app tools");
  const describedText = text(described);
  check(!describedText.includes(accounts[1])
    && !describedText.includes(atlassianPeople[1].pageMarker)
    && !describedText.includes(atlassianPeople[1].jiraMarker),
  "MCP describe does not expose peer account data");
  for (const [index, client] of clients.entries()) {
    const person = atlassianPeople[index];
    const peerAccount = accounts[1 - index];
    const site = yield* Effect.promise(() => call(client, "call", { calls: { path: paths.listSites, input: {} } }));
    const siteText = text(site);
    check(!site.isError, "Site list is available to its caller");
    check(siteText.includes(person.cloudId) && !siteText.includes(atlassianPeople[1 - index].cloudId),
      "Site list is private to the caller");
    const search = yield* Effect.promise(() => call(client, "call", { calls: { path: paths.searchConfluence, input: {
      cloudId: person.cloudId, cql: person.cql, limit: 5,
    } } }));
    check(!search.isError, "Confluence search succeeds for the caller");
    check(text(search).includes(person.pageMarker) && !text(search).includes(atlassianPeople[1 - index].pageMarker),
      "Confluence search returns only the caller's page");
    const page = yield* Effect.promise(() => call(client, "call", { calls: { path: paths.readConfluencePage, input: {
      cloudId: person.cloudId, pageId: person.pageId,
    } } }));
    check(!page.isError, "Confluence page read succeeds for the caller");
    check(text(page).includes(person.pageMarker) && !text(page).includes(atlassianPeople[1 - index].pageMarker),
      "Confluence page read returns only the caller's page");
    const issue = yield* Effect.promise(() => call(client, "call", { calls: { path: paths.getJiraIssue, input: {
      cloudId: person.cloudId, issueKey: person.issueKey,
    } } }));
    check(!issue.isError, "Jira issue read succeeds for the caller");
    check(text(issue).includes(person.jiraMarker) && !text(issue).includes(atlassianPeople[1 - index].jiraMarker),
      "Jira issue read returns only the caller's issue");
    const jiraSearch = yield* Effect.promise(() => call(client, "call", { calls: { path: paths.searchJiraIssues, input: {
      cloudId: person.cloudId, jql: `text ~ "${person.jiraMarker}"`, maxResults: 5,
    } } }));
    check(!jiraSearch.isError, "Jira search succeeds for the caller");
    check(text(jiraSearch).includes(person.issueKey)
      && !text(jiraSearch).includes(atlassianPeople[1 - index].issueKey)
      && !text(jiraSearch).includes(atlassianPeople[1 - index].jiraMarker),
    "Jira search returns only the caller's issue fields");

    const beforeForged = provider.apiRequests().length;
    const forged = yield* Effect.promise(() => call(client, "call", { calls: { path: paths.getJiraIssue, input: {
      cloudId: person.cloudId, issueKey: person.issueKey, $accounts: { atlassian: peerAccount },
    } } }));
    check(text(forged).includes("AccountChoiceUnsupported"), "MCP refuses peer account selection");
    check(provider.apiRequests().length === beforeForged, "Peer account selection is denied before provider access");
    const peerAccountRead = yield* request(index === 0 ? actors.member : actors.admin, "GET", `${prefix}/accounts/${peerAccount}`);
    check(peerAccountRead.status === 403 || peerAccountRead.status === 404, "Peer account details are denied");
    const peerLink = yield* request(index === 0 ? actors.member : actors.admin, "PUT",
      `${appPath}/accounts/user/atlassian/${encodeURIComponent(peerAccount)}`);
    check(peerLink.status === 403 || peerLink.status === 404, "Linking a peer account is denied");
  }

  const removePath = `${prefix}/accounts/${accounts[0]}`;
  checked(yield* request(actors.member, "DELETE", `${appPath}/accounts/user/atlassian/${encodeURIComponent(accounts[0])}`),
    200, "Unlink the member's personal app account");
  checked(yield* request(actors.member, "DELETE", removePath), 200, "Disconnect the member's Atlassian account");
  const beforeDisconnectedCall = provider.apiRequests().length;
  const disconnected = yield* Effect.promise(() => call(clients[0], "call", { calls: { path: paths.getJiraIssue, input: {
    cloudId: atlassianPeople[0].cloudId, issueKey: atlassianPeople[0].issueKey,
  } } }));
  check(disconnected.isError || text(disconnected).includes("AccountRequired"), "The next MCP request fails after disconnect");
  check(!text(disconnected).includes(atlassianPeople[0].jiraMarker), "Disconnected request returns no Jira data");
  check(provider.apiRequests().length === beforeDisconnectedCall, "Disconnected request fails before provider access");

  const connectedActorRead = yield* Effect.promise(() => call(clients[1], "call", { calls: { path: paths.getJiraIssue, input: {
    cloudId: atlassianPeople[1].cloudId, issueKey: atlassianPeople[1].issueKey,
  } } }));
  check(!connectedActorRead.isError, "Still-connected actor 1 can read Jira after actor 0 disconnects");
  check(text(connectedActorRead).includes(atlassianPeople[1].jiraMarker)
    && !text(connectedActorRead).includes(atlassianPeople[0].jiraMarker),
  "Actor 0 disconnect does not revoke actor 1's personal Atlassian access");

  const nativeClients = yield* Effect.promise(() => proveInstalledClients({
    root,
    directory,
    toolsOrigin: `${mcpOrigin}/mcp`,
    token: tokens[1],
    toolPaths: { searchConfluence: paths.searchConfluence, getJiraIssue: paths.getJiraIssue },
    person: atlassianPeople[1],
    realHome: protectedHome,
  }));

  return {
    checks,
    appId: deployed.id,
    appSlug: deployed.slug,
    sameOrganizationUsers: true,
    sharedCatalogApp: true,
    privateAccounts: true,
    confluenceSearch: true,
    confluenceRead: true,
    jiraRead: true,
    jiraSearch: true,
    peerAccountSelectionDenied: true,
    disconnectNextRequestFails: true,
    connectedActorReadAfterPeerDisconnect: true,
    nativeClients,
  };
});
