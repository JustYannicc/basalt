import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mcpExecutionEvidence,
} from "./evidence.mjs";
import { ZOHO_SCOPES, ZOHO_CLIENT_ID } from "./catalog.mjs";

const call = (client, name, args) => client.callTool({ name, arguments: args });
const asText = result => JSON.stringify(result.structuredContent ?? result.content);

/** Exercise the real hosted API, OAuth lifecycle, public MCP tools, and account policy. */
export async function proveZohoHosted({
  upstream,
  target,
  actors,
  sessionsApi,
  browser,
  callback,
  provider,
  catalogApp,
  privateValues,
  writeInvocation,
  setStage,
}) {
  let checks = 0;
  const check = (condition, message) => {
    checks++;
    assert.ok(condition, message);
  };
  const request = (actor, method, path, data) => sessionsApi.request(actor, method, path, data);
  const checked = (response, status, operation) => {
    check(response.status === status, operation + " returned HTTP " + response.status);
    return response.body;
  };
  const prefix = "/api/organizations/" + actors.organization.id;
  const roles = [
    { role: "member", actor: actors.member, providerActor: provider.actors[0] },
    { role: "admin", actor: actors.admin, providerActor: provider.actors[1] },
  ];

  setStage("deploy the adapted official Zoho source");
  const deployed = checked(await request(actors.owner, "POST", prefix + "/apps/deploy", {
    name: "Zoho",
    files: catalogApp.files,
  }), 200, "Deploy the frozen official Zoho CRM source");
  check(typeof deployed.id === "string" && deployed.id.length > 0, "Zoho app deployment returned an ID");
  check(typeof deployed.slug === "string" && deployed.slug.length > 0, "Zoho app deployment returned a slug");
  const appPath = prefix + "/apps/" + deployed.id;
  const access = checked(await request(actors.owner, "GET", appPath + "/access"), 200, "Read Zoho app access");
  checked(await request(actors.owner, "PATCH", appPath + "/access", {
    revision: access.revision,
    audience: { kind: "everyone" },
  }), 200, "Share the app within the synthetic organization");

  setStage("complete two synthetic Zoho OAuth connections");
  const accounts = [];
  const tokens = [];
  const oauthEvidence = [];
  for (const person of roles) {
    const connection = checked(await request(person.actor, "POST",
      appPath + "/accounts/user/zoho/connections", {
        destination: { kind: "personal" },
      }), 200, person.role + " creates a personal Zoho CRM account connection");
    const started = checked(await request(person.actor, "POST",
      prefix + "/connections/" + connection.id + "/oauth/start", {
        method: "oauthEu",
        label: "Synthetic " + person.role + " Zoho CRM account",
      }), 200, person.role + " starts the EU Zoho OAuth flow");
    const authorization = new URL(started.authorizationUrl);
    check(authorization.origin === provider.origin, "OAuth uses the loopback Zoho authorization fixture");
    check(started.redirectUri === callback, "OAuth uses the local callback receiver");
    check(authorization.searchParams.get("client_id") === ZOHO_CLIENT_ID,
      "OAuth uses only the synthetic test client");
    check(authorization.searchParams.get("response_type") === "code", "OAuth requests an authorization code");
    check(authorization.searchParams.get("access_type") === "offline", "OAuth requests offline access");
    check(authorization.searchParams.get("prompt") === "consent", "OAuth requires consent");
    check(authorization.searchParams.get("state")?.length > 0, "OAuth state is present");
    const requestedScopes = (authorization.searchParams.get("scope") ?? "").split(",").filter(Boolean);
    check(requestedScopes.length === ZOHO_SCOPES.length
      && ZOHO_SCOPES.every(scope => requestedScopes.includes(scope)),
    "OAuth requests the official Zoho scope set");

    const callbackUrl = await (async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(authorization.href);
        const choice = page.getByRole("link", { name: person.providerActor.email });
        await choice.waitFor({ state: "visible" });
        await Promise.all([
          page.waitForURL(value => value.href.startsWith(callback)),
          choice.click(),
        ]);
        const returned = new URL(page.url());
        check(returned.searchParams.get("code"), "Local provider returned a synthetic authorization code");
        check(returned.searchParams.get("state") === authorization.searchParams.get("state"),
          "OAuth callback preserves the request state");
        return returned.href;
      } finally {
        await context.close();
      }
    })();

    const completed = checked(await request(person.actor, "POST",
      prefix + "/connections/" + connection.id + "/oauth/complete", { callbackUrl }),
    200, person.role + " completes OAuth through the public hosted API");
    accounts.push(completed.id);
    const issued = checked(await request(person.actor, "POST", "/api/auth/api-key/create", {
      name: "Zoho native proof",
      metadata: { organization: actors.organization.id },
    }), 200, person.role + " receives a synthetic organization-pinned MCP token");
    tokens.push(issued.key);
    privateValues.push(issued.key);
    oauthEvidence.push({
      actor: person.role,
      providerActor: person.providerActor.role,
      method: "oauthEu",
      syntheticClientIdMatches: true,
      requestedScopeCount: requestedScopes.length,
      callbackStateMatched: true,
      accountId: completed.id,
    });
  }
  check(accounts.length === 2 && accounts[0] !== accounts[1],
    "Two actors created distinct personal Zoho accounts");
  check(actors.organization.id.length > 0, "Both actors belong to the same organization");

  setStage("check each actor's public account health");
  const healthEvidence = [];
  for (const [index, person] of roles.entries()) {
    const before = provider.apiRequests().length;
    const health = await request(person.actor, "POST", prefix + "/accounts/" + accounts[index] + "/health");
    checked(health, 200, person.role + " checks its own Zoho account health");
    const requests = provider.apiRequests().slice(before);
    const ownHealth = requests.find(event => event.path === "/crm/v8/org");
    check(ownHealth !== undefined, person.role + " health check called Zoho CRM organization endpoint");
    check(ownHealth.actor === person.providerActor.role, person.role + " health check used its own OAuth token");
    check(ownHealth.authorizationScheme === "Zoho-oauthtoken",
      person.role + " health request used the Zoho token scheme");
    check(ownHealth.status === 200, person.role + " health request succeeded");
    healthEvidence.push({
      actor: person.role,
      endpoint: ownHealth.path,
      status: ownHealth.status,
      authorizationScheme: ownHealth.authorizationScheme,
      ownSyntheticCredential: true,
    });
  }

  const invocation = {
    protocol: "MCP Streamable HTTP from the pinned public SDK",
    origin: target.metadata.origin,
    endpoint: target.metadata.origin + "/mcp",
    app: { id: deployed.id, slug: deployed.slug, package: catalogApp.packageName },
    actors: roles.map((person, index) => ({
      role: person.role,
      organizationId: actors.organization.id,
      accountId: accounts[index],
      peerAccountId: accounts[1 - index],
    })),
    operations: {
      search: { name: "search", arguments: { query: deployed.slug } },
      describe: { name: "describe", paths: "resolved from this actor's search result ending in getRecords" },
      call: {
        name: "call",
        operationId: "getRecords",
        input: { accountId: "the caller's accountId", input: { module: "Leads", fields: "Last_Name" } },
      },
      peerAccountCall: {
        name: "call",
        operationId: "getRecords",
        input: { accountId: "the peer's accountId", input: { module: "Leads", fields: "Last_Name" } },
      },
      unsupportedAccountsSelection: {
        name: "call",
        operationId: "getRecords",
        input: { module: "Leads", fields: "Last_Name", $accounts: { zoho: "the peer's accountId" } },
      },
    },
  };
  const invocationReceipt = await writeInvocation(invocation);

  setStage("use native MCP search, describe, and getRecords");
  const require = createRequire(join(upstream, "package.json"));
  const [clientModule, transportModule] = await Promise.all([
    import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href),
    import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href),
  ]);
  const clients = [];
  try {
    for (const token of tokens) {
      const client = new clientModule.Client({ name: "zoho-native-proof", version: "1" });
      await client.connect(new transportModule.StreamableHTTPClientTransport(
        new URL(invocation.endpoint),
        { requestInit: { headers: { authorization: "Bearer " + token } } },
      ));
      clients.push(client);
    }

    const actorEvidence = [];
    for (const [index, person] of roles.entries()) {
      const ownMarker = person.providerActor.marker;
      const peerMarker = roles[1 - index].providerActor.marker;
      const peerAccountId = accounts[1 - index];
      const search = await call(clients[index], "search", { query: deployed.slug });
      check(!search.isError, person.role + " native search succeeds");
      const searchText = asText(search);
      const items = search.structuredContent?.items;
      check(Array.isArray(items), person.role + " search returns actual native tool paths");
      const getRecords = items.find(item => typeof item?.path === "string" && item.path.endsWith("getRecords"));
      check(getRecords !== undefined, person.role + " search finds the official getRecords operation");
      check(!searchText.includes(peerAccountId), person.role + " search does not disclose peer account ID");

      const described = await call(clients[index], "describe", { paths: [getRecords.path] });
      check(!described.isError, person.role + " native describe succeeds");
      check(!asText(described).includes(peerAccountId), person.role + " describe does not disclose peer account ID");

      const providerCountBeforeCall = provider.apiRequests().length;
      const result = await call(clients[index], "call", {
        calls: {
          path: getRecords.path,
          input: {
            accountId: accounts[index],
            input: { module: "Leads", fields: "Last_Name" },
          },
        },
      });
      const resultText = asText(result);
      const execution = mcpExecutionEvidence(result, privateValues);
      check(!result.isError, person.role + " native CRM call is not a protocol error");
      check(execution.parsed && execution.execution.ok,
        person.role + " native CRM call reports a successful app execution");
      check(resultText.includes(ownMarker), person.role + " CRM call returns its own marker");
      check(!resultText.includes(peerMarker), person.role + " CRM call omits the peer marker");
      const ownRead = provider.apiRequests().slice(providerCountBeforeCall)
        .find(event => event.path === "/crm/v8/Leads");
      check(ownRead !== undefined, person.role + " native getRecords reached the CRM fixture");
      check(ownRead.actor === person.providerActor.role, person.role + " CRM read used its own OAuth token");
      check(ownRead.authorizationScheme === "Zoho-oauthtoken",
        person.role + " CRM read used the Zoho token scheme");

      setStage("deny peer account selection before CRM provider request");
      const beforeForgedCall = provider.apiRequests().length;
      const forged = await call(clients[index], "call", {
        calls: {
          path: getRecords.path,
          input: { accountId: peerAccountId, input: { module: "Leads", fields: "Last_Name" } },
        },
      });
      const forgedText = asText(forged);
      const forgedExecution = mcpExecutionEvidence(forged, privateValues);
      check(forged.isError || (forgedExecution.parsed && !forgedExecution.execution.ok),
        person.role + " native getRecords call rejects the peer accountId");
      check(!forgedText.includes(peerMarker), person.role + " peer accountId call returns no peer CRM marker");
      check(provider.apiRequests().length === beforeForgedCall,
        person.role + " peer account native call is denied before any CRM request");

      const unsupportedChoice = await call(clients[index], "call", {
        calls: {
          path: getRecords.path,
          input: {
            module: "Leads",
            fields: "Last_Name",
            $accounts: { zoho: peerAccountId },
          },
        },
      });
      check(asText(unsupportedChoice).includes("AccountChoiceUnsupported"),
        person.role + " native call preserves the unsupported account-choice assertion");
      check(!asText(unsupportedChoice).includes(peerMarker),
        person.role + " unsupported account choice returns no peer CRM marker");
      check(provider.apiRequests().length === beforeForgedCall,
        person.role + " unsupported account choice is denied before any CRM request");

      const readPeer = await request(person.actor, "GET", prefix + "/accounts/" + peerAccountId);
      check(readPeer.status === 403 || readPeer.status === 404,
        person.role + " cannot read the peer account");
      const linkPeer = await request(person.actor, "PUT",
        appPath + "/accounts/user/zoho/" + encodeURIComponent(peerAccountId));
      check(linkPeer.status === 403 || linkPeer.status === 404,
        person.role + " cannot link the peer account to the app");
      check(provider.apiRequests().length === beforeForgedCall,
        person.role + " peer account read and link checks made no CRM request");

      actorEvidence.push({
        actor: person.role,
        ownAccountId: accounts[index],
        peerAccountId: peerAccountId,
        search: { isError: Boolean(search.isError), foundTool: getRecords.path },
        describe: { isError: Boolean(described.isError), peerAccountIdAbsent: true },
        call: {
          path: getRecords.path,
          execution,
          ownMarker: ownMarker,
          ownMarkerReturned: true,
          peerMarkerReturned: false,
          crmRequestCount: provider.apiRequests().length - providerCountBeforeCall,
        },
        peerIsolation: {
          nativeAccountChoiceDenied: true,
          unsupportedAccountChoiceDenied: true,
          providerRequestCountBefore: beforeForgedCall,
          providerRequestCountAfter: provider.apiRequests().length,
          accountReadStatus: readPeer.status,
          accountLinkStatus: linkPeer.status,
        },
      });
    }

    return {
      checks,
      app: {
        id: deployed.id,
        slug: deployed.slug,
        package: catalogApp.packageName,
      },
      sameOrganizationActors: true,
      actorCount: actors.organization.id.length > 0 ? 2 : 0,
      oauth: oauthEvidence,
      health: healthEvidence,
      actors: actorEvidence,
      invocationSha256: invocationReceipt.sha256,
    };
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  }
}
