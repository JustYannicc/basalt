import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { proveInstalledClaude } from "./native-claude.mjs";

function tool(items, name) {
  const found = items?.find((entry) => entry.path.endsWith(`.${name}`));
  assert.ok(found, `Native MCP did not list Zendesk ${name}`);
  return found;
}

async function connectMcp(upstream, origin, token, organization) {
  const require = createRequire(join(upstream, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);
  const client = new Client({ name: "zendesk-native-proof", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, "X-Executor-Organization": organization } },
  }));
  return client;
}

const textOf = (result) => JSON.stringify(result?.structuredContent ?? result?.content ?? result);

/** Exercise native MCP health, reads, approvals, peer isolation, and the installed agent client. */
export function proveZendeskMcp({
  Effect, request, checked, actors, directory, prefix, target, root, upstream, fixtures, users, flowByKey, record, step,
}) {
  return Effect.gen(function* () {
    const issuedKeys = [];
    for (const actor of [actors.owner, actors.member, actors.admin]) {
      const key = checked(yield* request(actor, "POST", "/api/auth/api-key/create", {
        name: "Zendesk native proof",
        metadata: { organization: actors.organization.id },
      }), 200, "Create a synthetic organization-pinned MCP token");
      issuedKeys.push({ actor, id: key.id, key: key.key });
    }
    yield* Effect.addFinalizer(() =>
      Effect.forEach(issuedKeys, ({ actor, id }) =>
        request(actor, "POST", "/api/auth/api-key/delete", { keyId: id }).pipe(Effect.ignore),
      ).pipe(Effect.as(undefined)),
    );

    const mcpClients = new Map();
    for (const { actor, key } of issuedKeys) {
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => connectMcp(upstream, target.metadata.origin, key, actors.organization.id)),
        (client) => Effect.promise(() => client.close()),
      );
      mcpClients.set(actor, client);
    }

    for (const flow of users) {
      const account = flow.account;
      assert.ok(account && typeof account.id === "string", "OAuth completion did not return its account ID");
      const beforeHealth = fixtures.observations().length;
      const health = checked(yield* request(flow.actor, "POST", `${prefix}/accounts/${account.id}/health`), 200,
        `Health check Zendesk account at ${flow.site.id}`);
      flow.health = health;
      if (flow.mode === "hosted") {
        const expectedId = flow.site.id === "site-a" ? "9101" : "9202";
        assert.equal(health.accountInfo?.externalId, expectedId,
          `Hosted health for ${flow.site.id} must describe that site's connected user`);
        assert.equal(health.accountInfo?.displayName, `Zendesk fixture ${flow.site.id}`);
        const healthEvents = fixtures.observations().slice(beforeHealth);
        const apiEvents = healthEvents.filter((event) => event.phase === "api");
        assert.ok(apiEvents.some((event) =>
          event.endpoint === "/api/v2/users/me.json"
            && event.site === flow.site.id
            && event.flowMode === "hosted"
            && event.credentialSiteMatches,
        ), `Hosted health must send the token only to ${flow.site.id}`);
        assert.equal(apiEvents.some((event) => event.site !== flow.site.id), false,
          `Hosted health for ${flow.site.id} must not egress to its peer site`);
      }
      record("account-health", { site: flow.site.id, host: flow.site.host, status: 200 });
    }

    for (const flow of users) {
      const client = mcpClients.get(flow.actor);
      const search = yield* Effect.promise(() => client.callTool({ name: "search", arguments: { query: flow.app.slug } }));
      assert.equal(search.isError, false, `Native MCP search failed for ${flow.site.id}`);
      const current = tool(search.structuredContent?.items, "currentUser");
      const tickets = tool(search.structuredContent?.items, "listTickets");
      const create = tool(search.structuredContent?.items, "createTicket");
      const described = yield* Effect.promise(() => client.callTool({ name: "describe", arguments: { paths: [current.path, tickets.path, create.path] } }));
      assert.equal(described.isError, false, `Native MCP describe failed for ${flow.site.id}`);
      const accountInput = { accountId: flow.account.id, input: {} };
      const beforeCurrentUser = fixtures.observations().length;
      const currentResult = yield* Effect.promise(() => client.callTool({ name: "call", arguments: { calls: { path: current.path, input: accountInput } } }));
      assert.equal(currentResult.isError, false, `Native MCP currentUser failed for ${flow.site.id}`);
      assert.ok(textOf(currentResult).includes(`Zendesk fixture ${flow.site.id}`));
      if (flow.mode === "hosted") {
        const apiEvents = fixtures.observations().slice(beforeCurrentUser).filter((event) => event.phase === "api");
        assert.ok(apiEvents.some((event) =>
          event.endpoint === "/api/v2/users/me.json"
            && event.site === flow.site.id
            && event.flowMode === "hosted"
            && event.credentialSiteMatches,
        ), `The hosted catalog tool must call only ${flow.site.id}`);
        assert.equal(apiEvents.some((event) => event.site !== flow.site.id), false,
          `The hosted catalog tool for ${flow.site.id} must not place its token at its peer`);
      }
      const ticketResult = yield* Effect.promise(() => client.callTool({ name: "call", arguments: {
        calls: { path: tickets.path, input: { accountId: flow.account.id, input: { page: 1, perPage: 10 } } },
      } }));
      assert.equal(ticketResult.isError, false, `Native MCP listTickets failed for ${flow.site.id}`);
      assert.ok(textOf(ticketResult).includes(`Synthetic ${flow.site.id} ticket`));
      record("native-mcp-read", {
        site: flow.site.id,
        host: flow.site.host,
        currentUserPath: current.path,
        listTicketsPath: tickets.path,
        ownAccountRead: true,
      });

      const approvalDescriptor = JSON.stringify(create) + " " + textOf(described);
      assert.match(approvalDescriptor, /approval|human approval/i,
        "Zendesk createTicket must remain marked for approval in its native descriptor");
      const ticketWritesBefore = fixtures.observations().filter((event) =>
        event.phase === "api" && event.method === "POST" && event.endpoint === "/api/v2/tickets.json",
      ).length;
      const write = yield* Effect.promise(() => client.callTool({ name: "call", arguments: { calls: {
        path: create.path,
        input: { accountId: flow.account.id, input: { subject: "Synthetic approval check", comment: "Must not reach Zendesk without approval" } },
      } } }));
      const writeOutcome = textOf(write);
      assert.ok(write.isError || /approval|approval.required|approval required/i.test(writeOutcome),
        "Zendesk createTicket must request approval through MCP");
      assert.equal(fixtures.observations().filter((event) =>
        event.phase === "api" && event.method === "POST" && event.endpoint === "/api/v2/tickets.json",
      ).length, ticketWritesBefore, "An unapproved createTicket must not reach the external API");
      record("ticket-create-approval-preserved", { site: flow.site.id, host: flow.site.host, providerWriteCount: 0 });
    }

    const owner = issuedKeys.find(({ actor }) => actor === actors.owner);
    assert.ok(owner, "Owner MCP token is missing");
    const siteAOwner = flowByKey.get("site-a:public");
    const siteBOwner = flowByKey.get("site-b:confidential");
    const ownerClient = mcpClients.get(actors.owner);
    const searchA = yield* Effect.promise(() => ownerClient.callTool({ name: "search", arguments: { query: siteAOwner.app.slug } }));
    const siteATool = tool(searchA.structuredContent?.items, "currentUser");
    const peerAccountCountBefore = fixtures.observations().filter((event) => event.phase === "api").length;
    const peerAccountCall = yield* Effect.promise(() => ownerClient.callTool({ name: "call", arguments: { calls: {
      path: siteATool.path,
      input: { accountId: siteBOwner.account.id, input: {} },
    } } }));
    assert.ok(peerAccountCall.isError || /InputInvalid|account/i.test(textOf(peerAccountCall)),
      "A site-b account must not be selectable for the site-a app");
    assert.equal(fixtures.observations().filter((event) => event.phase === "api").length, peerAccountCountBefore,
      "Rejected cross-site account selection must not send credentials to either Zendesk host");
    record("cross-site-account-selection-denied", {
      site: "site-a",
      host: siteAOwner.site.host,
      peerSite: "site-b",
      providerRequestCount: 0,
    });

    const agentPath = siteATool.path;
    const agentMarker = `Zendesk fixture ${siteAOwner.site.id}`;
    yield* Effect.promise(() => proveInstalledClaude({
      root,
      directory,
      origin: target.metadata.origin,
      token: owner.key,
      slug: siteAOwner.app.slug,
      toolPath: agentPath,
      marker: agentMarker,
      taskPrompt: `Search the synthetic Zendesk app ${siteAOwner.app.slug}, call currentUser for my connected account, then reply connector-runtime-proof-ok.`,
      toolInput: { accountId: siteAOwner.account.id, input: {} },
      searchQuery: siteAOwner.app.slug,
    }));
    record("installed-agent-native-tool-call", { site: "site-a", host: siteAOwner.site.host, toolPath: agentPath });
  });
}
