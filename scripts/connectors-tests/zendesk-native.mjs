import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { proveInstalledClaude } from "./native-claude.mjs";
import { singleCallValue, singleCallOutcome } from "./mcp-output.mjs";
import { proveZendeskPeerPlacement } from "./zendesk-peer-placement.mjs";

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
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?elicitation_mode=model`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, "X-Executor-Organization": organization } },
  }));
  return client;
}

const textOf = (result) => JSON.stringify(result?.structuredContent ?? result?.content ?? result);

/** Exercise native MCP health, reads, approvals, peer isolation, and the installed agent client. */
export function proveZendeskMcp({
  Effect, request, checked, actors, directory, prefix, target, root, upstream, fixtures, catalog, users, flowByKey, record, step,
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
        assert.equal(health.info?.externalId, expectedId,
          `Hosted health for ${flow.site.id} must describe that site's connected user`);
        assert.equal(health.info?.displayName, `Zendesk fixture ${flow.site.id}`);
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
      const linked = checked(yield* request(flow.actor, "GET", `${flow.app.path}/accounts/user/zendesk`),
        200, "Read the caller's linked Zendesk account before the MCP call");
      assert.deepEqual(linked.accounts.filter((entry) => entry.linked).map((entry) => entry.account.id),
        [flow.account.id], "MCP must use this flow's account through its normal app link");
      const search = yield* Effect.promise(() => client.callTool({ name: "search", arguments: { query: flow.app.slug } }));
      assert.equal(search.isError, false, `Native MCP search failed for ${flow.site.id}`);
      const current = tool(search.structuredContent?.items, "currentUser");
      const tickets = tool(search.structuredContent?.items, "listTickets");
      const create = tool(search.structuredContent?.items, "createTicket");
      const supportUserSearch = yield* Effect.promise(() => client.callTool({ name: "search", arguments: {
        query: `${flow.app.slug}.api.users.showCurrentUser`,
        namespace: flow.app.slug, limit: 1,
      } }));
      assert.equal(supportUserSearch.isError, false, "Native MCP search failed for imported current-user read");
      const supportUser = supportUserSearch.structuredContent?.items?.find((entry) =>
        entry.path.endsWith(".api.users.showCurrentUser"),
      );
      const supportCreateSearch = yield* Effect.promise(() => client.callTool({ name: "search", arguments: {
        query: `${flow.app.slug}.api.tickets.createTicket`,
        namespace: flow.app.slug, limit: 1,
      } }));
      assert.equal(supportCreateSearch.isError, false, "Native MCP search failed for imported ticket creation");
      const supportCreate = supportCreateSearch.structuredContent?.items?.find((entry) =>
        entry.path !== create.path && entry.path.endsWith(".api.tickets.createTicket"),
      );
      assert.ok(supportUser, "Imported Support API must expose its current-user read");
      assert.ok(supportCreate, "Imported Support API must expose ticket creation as a mutation");
      const described = yield* Effect.promise(() => client.callTool({ name: "describe", arguments: {
        paths: [current.path, tickets.path, create.path, supportUser.path, supportCreate.path],
      } }));
      assert.equal(described.isError, false, `Native MCP describe failed for ${flow.site.id}`);
      const beforeCurrentUser = fixtures.observations().length;
      const currentResult = yield* Effect.promise(() => client.callTool({ name: "call", arguments: { calls: { path: current.path, input: {} } } }));
      const currentOutcome = singleCallOutcome(currentResult, current.path);
      if (!currentOutcome.ok) record("native-mcp-failure", { site: flow.site.id, mode: flow.mode, path: current.path, error: currentOutcome.error });
      assert.equal(singleCallValue(currentResult, current.path)?.name, `Zendesk fixture ${flow.site.id}`);
      const supportUserBefore = fixtures.observations().length;
      const supportUserResult = yield* Effect.promise(() => client.callTool({ name: "call", arguments: {
        calls: { path: supportUser.path, input: {} },
      } }));
      assert.equal(supportUserResult.isError, false,
        `Imported Support API current-user read failed for ${flow.site.id}`);
      assert.match(textOf(supportUserResult), new RegExp(`Zendesk fixture ${flow.site.id}`));
      const supportRead = fixtures.observations().slice(supportUserBefore).find((event) =>
        event.phase === "api" && event.endpoint === "/api/v2/users/me",
      );
      assert.equal(supportRead?.site, flow.site.id,
        `Imported Support API read must use ${flow.site.id}'s saved site`);
      assert.equal(supportRead?.credentialSiteMatches, true,
        `Imported Support API read must use ${flow.site.id}'s credential`);
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
        calls: { path: tickets.path, input: { page: 1, perPage: 10 } },
      } }));
      assert.ok(singleCallValue(ticketResult, tickets.path)?.tickets.some((ticket) =>
        ticket.subject === `Synthetic ${flow.site.id} ticket`,
      ));
      record("native-mcp-read", {
        site: flow.site.id,
        host: flow.site.host,
        currentUserPath: current.path,
        listTicketsPath: tickets.path,
        ownAccountRead: true,
      });

      const approvalDescriptor = JSON.stringify(create) + " " + JSON.stringify(supportCreate) + " " + textOf(described);
      assert.match(approvalDescriptor, /approval|human approval/i,
        "Zendesk createTicket must remain marked for approval in its native descriptor");
      const ticketWritesBefore = fixtures.observations().filter((event) =>
        event.phase === "api" && event.method === "POST" && event.endpoint === "/api/v2/tickets.json",
      ).length;
      const write = yield* Effect.promise(() => client.callTool({ name: "call", arguments: { calls: {
        path: create.path,
        input: { subject: "Synthetic approval check", comment: "Must not reach Zendesk without approval" },
      } } }));
      assert.notEqual(write.isError, true, "The approval request must be a successful MCP response");
      assert.equal(write.structuredContent?.status, "approval-required",
        "Zendesk createTicket must pause specifically for approval");
      assert.equal(typeof write.structuredContent.requestId, "string");
      assert.equal(write.structuredContent.invocation?.app, flow.app.id);
      assert.equal(write.structuredContent.invocation?.tool, "createTicket");
      assert.equal(fixtures.observations().filter((event) =>
        event.phase === "api" && event.method === "POST" && event.endpoint === "/api/v2/tickets.json",
      ).length, ticketWritesBefore, "An unapproved createTicket must not reach the external API");
      record("ticket-create-approval-preserved", { site: flow.site.id, host: flow.site.host, providerWriteCount: 0 });

      const supportWritesBefore = fixtures.observations().filter((event) =>
        event.phase === "api" && event.method === "POST" && event.endpoint === "/api/v2/tickets",
      ).length;
      const supportWrite = yield* Effect.promise(() => client.callTool({ name: "call", arguments: { calls: {
        path: supportCreate.path,
        input: { body: { ticket: { subject: "Synthetic OpenAPI approval check", comment: {
          body: "This imported write must wait for approval",
        } } } },
      } } }));
      assert.notEqual(supportWrite.isError, true,
        "The imported Support API approval request must be a successful MCP response");
      assert.equal(supportWrite.structuredContent?.status, "approval-required",
        "Imported Zendesk ticket writes must stop for approval");
      assert.equal(typeof supportWrite.structuredContent.requestId, "string");
      assert.equal(fixtures.observations().filter((event) =>
        event.phase === "api" && event.method === "POST" && event.endpoint === "/api/v2/tickets",
      ).length, supportWritesBefore, "An unapproved imported ticket write must not reach the provider");
      record("openapi-ticket-create-approval-preserved", {
        site: flow.site.id,
        host: flow.site.host,
        providerWriteCount: 0,
      });
    }

    yield* proveZendeskPeerPlacement({
      Effect,
      request,
      checked,
      actors,
      prefix,
      fixtures,
      catalog,
      client: mcpClients.get(actors.admin),
      record,
    });

    const owner = issuedKeys.find(({ actor }) => actor === actors.owner);
    assert.ok(owner, "Owner MCP token is missing");
    const siteAOwner = flowByKey.get("site-a:public");
    const siteBPeer = flowByKey.get("site-b:public");
    const ownerClient = mcpClients.get(actors.owner);
    const searchA = yield* Effect.promise(() => ownerClient.callTool({ name: "search", arguments: { query: siteAOwner.app.slug } }));
    const siteATool = tool(searchA.structuredContent?.items, "currentUser");
    const peerAccountCountBefore = fixtures.observations().filter((event) => event.phase === "api").length;
    const peerAccountLink = yield* request(actors.owner, "PUT",
      `${siteAOwner.app.path}/accounts/user/zendesk/${siteBPeer.account.id}`);
    assert.ok(peerAccountLink.status === 403 || peerAccountLink.status === 404,
      "A caller cannot link another user's private account");
    const stillLinked = checked(yield* request(actors.owner, "GET", `${siteAOwner.app.path}/accounts/user/zendesk`),
      200, "Read the unchanged caller account link after peer-account refusal");
    assert.deepEqual(stillLinked.accounts.filter((entry) => entry.linked).map((entry) => entry.account.id),
      [siteAOwner.account.id]);
    assert.equal(fixtures.observations().filter((event) => event.phase === "api").length, peerAccountCountBefore,
      "Rejected peer-user account linking must not send credentials to either Zendesk host");
    record("peer-user-account-link-denied", {
      site: "site-a",
      host: siteAOwner.site.host,
      peerSite: "site-b",
      providerRequestCount: 0,
    });

    const agentPath = siteATool.path;
    const agentMarker = `Zendesk fixture ${siteAOwner.site.id}`;
    const skipInstalledClaude = process.env.CONNECTORS_PROOF_SKIP_CLAUDE === "1";
    if (skipInstalledClaude) {
      record("installed-agent-native-tool-call-skipped", { reason: "explicit-skip-claude" });
    } else {
      yield* Effect.promise(() => proveInstalledClaude({
        root,
        directory,
        origin: target.metadata.origin,
        token: owner.key,
        slug: siteAOwner.app.slug,
        toolPath: agentPath,
        marker: agentMarker,
        taskPrompt: `Search the synthetic Zendesk app ${siteAOwner.app.slug}, call currentUser for my connected account, then reply connector-runtime-proof-ok.`,
        toolInput: {},
        searchQuery: siteAOwner.app.slug,
      }));
      record("installed-agent-native-tool-call", { site: "site-a", host: siteAOwner.site.host, toolPath: agentPath });
    }
    return {
      installedAgentNativeToolCall: !skipInstalledClaude,
      installedAgentNativeToolCallSkipped: skipInstalledClaude,
    };
  });
}
