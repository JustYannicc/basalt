import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Effect } from "effect";
import { proveInstalledClaude } from "./native-claude.mjs";

const textOf = (value) => JSON.stringify(value?.structuredContent ?? value?.content ?? value);
const slackPostCount = (mock) => mock.observations().api.filter((item) => item.operation === "chat.postMessage").length;

function toolPath(items, parts, operation) {
  const path = items?.find((item) => {
    const normalized = item.path.toLowerCase().replace(/[^a-z0-9]/g, "");
    return parts.every((part) => normalized.includes(part));
  })?.path;
  if (!path) throw new Error(`OpenAPI search did not return ${operation}`);
  return path;
}

async function createClient(upstream, origin, token, organization, native) {
  const require = createRequire(join(upstream, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);
  const client = new Client(
    { name: "slack-acceptance-proof", version: "1" },
    native ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const endpoint = new URL(`${origin}/mcp`);
  if (native) endpoint.searchParams.set("elicitation_mode", "native");
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}`, "X-Executor-Organization": organization } },
  }));
  return client;
}

/** Public native MCP proof for caller identity, account isolation and write approval. */
export function proveSlackMcp({ root, upstream, directory, target, actors, request, checked,
  prefix, app, ownerAccount, memberAccount, mock, check, equal }) {
  return Effect.gen(function* () {
    const issued = [];
    for (const actor of [actors.owner, actors.member]) {
      const token = checked(yield* request(actor, "POST", "/api/auth/api-key/create", {
        name: "Slack acceptance proof", metadata: { organization: actors.organization.id },
      }), 200, "Create a synthetic organization-pinned MCP token");
      issued.push({ actor, id: token.id, key: token.key });
    }
    yield* Effect.addFinalizer(() =>
      Effect.forEach(issued, ({ actor, id }) =>
        request(actor, "POST", "/api/auth/api-key/delete", { keyId: id }).pipe(Effect.ignore),
      ).pipe(Effect.as(undefined)),
    );

    const nativeClients = [];
    for (const { key } of issued) {
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => createClient(upstream, target.metadata.origin, key, actors.organization.id, true)),
        (client) => Effect.promise(() => client.close()),
      );
      nativeClients.push(client);
    }
    const standard = yield* Effect.acquireRelease(
      Effect.promise(() => createClient(upstream, target.metadata.origin, issued[0].key, actors.organization.id, false)),
      (client) => Effect.promise(() => client.close()),
    );

    let historyPath;
    let postPath;
    for (const [index, client] of nativeClients.entries()) {
      const peerAccount = index === 0 ? memberAccount : ownerAccount;
      const ownMarker = index === 0 ? "synthetic_owner_history" : "synthetic_member_history";
      const peerMarker = index === 0 ? "synthetic_member_history" : "synthetic_owner_history";
      const search = yield* Effect.promise(() => client.callTool({ name: "search", arguments: { query: "conversations.history" } }));
      check(!search.isError, "Native MCP could not search Slack OpenAPI tools");
      const searchText = textOf(search);
      check(!searchText.includes(peerAccount), "Native MCP exposed the peer account during discovery");
      const currentHistory = toolPath(search.structuredContent?.items ?? [], ["conversations", "history"], "conversations.history");
      const secondSearch = yield* Effect.promise(() => client.callTool({ name: "search", arguments: { query: "chat.postMessage" } }));
      check(!secondSearch.isError, "Native MCP could not search for chat.postMessage");
      const currentPost = toolPath(secondSearch.structuredContent?.items ?? [], ["chat", "postmessage"], "chat.postMessage");
      historyPath ??= currentHistory;
      if (postPath === undefined) postPath = currentPost;
      else equal(currentPost, postPath, "Slack clients did not discover the same chat.postMessage operation");

      const described = yield* Effect.promise(() => client.callTool({ name: "describe", arguments: { paths: [currentHistory, currentPost] } }));
      check(!described.isError && !textOf(described).includes(peerAccount), "Native describe exposed peer account details");
      const read = yield* Effect.promise(() => client.callTool({ name: "call", arguments: {
        calls: { path: currentHistory, input: { channel: "C_SYNTHETIC" } },
      } }));
      const readText = textOf(read);
      check(!read.isError && readText.includes(ownMarker) && !readText.includes(peerMarker), "Native MCP read the wrong Slack account");

      const readForgery = yield* Effect.promise(() => client.callTool({ name: "call", arguments: {
        calls: { path: currentHistory, input: { channel: "C_SYNTHETIC", $accounts: { slack: peerAccount } } },
      } }));
      check(textOf(readForgery).includes("AccountChoiceUnsupported"), "Native MCP allowed selecting the peer Slack account");
      const executeForgery = yield* Effect.promise(() => client.callTool({ name: "execute", arguments: {
        code: `return await ${currentHistory}({ channel: "C_SYNTHETIC", $accounts: { slack: ${JSON.stringify(peerAccount)} } });`,
      } }));
      check(textOf(executeForgery).includes("AccountChoiceUnsupported"), "MCP execute allowed selecting the peer Slack account");

      const peerWriteInput = {
        channel: "C_SYNTHETIC",
        text: `synthetic_forbidden_${index}_post`,
        $accounts: { slack: peerAccount },
      };
      const postsBeforePeerWrite = slackPostCount(mock);
      const peerWrite = yield* Effect.promise(() => client.callTool({ name: "call", arguments: {
        calls: { path: currentPost, input: peerWriteInput },
      } }));
      check(textOf(peerWrite).includes("AccountChoiceUnsupported"),
        "Native MCP call allowed chat.postMessage with the peer Slack account");
      equal(slackPostCount(mock), postsBeforePeerWrite,
        "A rejected peer-account call reached Slack chat.postMessage");
      const peerExecute = yield* Effect.promise(() => client.callTool({ name: "execute", arguments: {
        code: `return await ${currentPost}(${JSON.stringify(peerWriteInput)});`,
      } }));
      check(textOf(peerExecute).includes("AccountChoiceUnsupported"),
        "MCP execute allowed chat.postMessage with the peer Slack account");
      equal(slackPostCount(mock), postsBeforePeerWrite,
        "A rejected peer-account execute reached Slack chat.postMessage");

      const actor = index === 0 ? actors.owner : actors.member;
      const inspectPeer = yield* request(actor, "GET", `${prefix}/accounts/${peerAccount}`);
      check(inspectPeer.status === 403 || inspectPeer.status === 404, "A person could read the peer account record");
      const linkPeer = yield* request(actor, "PUT",
        `${prefix}/apps/${app.id}/accounts/user/slack/${encodeURIComponent(peerAccount)}`);
      check(linkPeer.status === 403 || linkPeer.status === 404, "A person could link the peer account");
    }

    const nativeTools = yield* Effect.promise(() => nativeClients[0].listTools());
    const callToolDefinition = nativeTools.tools.find((tool) => tool.name === "call");
    check(callToolDefinition?.annotations?.readOnlyHint === false
      && callToolDefinition?.annotations?.destructiveHint === true
      && callToolDefinition?.annotations?.openWorldHint === true,
    "Native MCP call did not carry caller approval annotations");
    const writeInput = { channel: "C_SYNTHETIC", text: "synthetic_owner_post" };
    const callsBeforeApproval = slackPostCount(mock);
    const executeWrite = yield* Effect.promise(() => standard.callTool({ name: "execute", arguments: {
      code: `return await ${postPath}(${JSON.stringify(writeInput)});`,
    } }));
    const pendingText = textOf(executeWrite);
    check(pendingText.includes("approval-required") || pendingText.includes("ToolApprovalRequired"),
      "The maintained mutation approval flow did not pause chat.postMessage");
    equal(slackPostCount(mock),
      callsBeforeApproval, "chat.postMessage reached Slack before approval");
    const posted = yield* Effect.promise(() => nativeClients[0].callTool({ name: "call", arguments: {
      calls: { path: postPath, input: writeInput },
    } }));
    check(!posted.isError && textOf(posted).includes("synthetic_owner_post"), "Native MCP did not post as the caller");
    equal(slackPostCount(mock), callsBeforeApproval + 1,
      "The approved native MCP write did not reach Slack exactly once");
    const writeCall = mock.observations().api.filter((item) => item.operation === "chat.postMessage").at(-1);
    equal(writeCall?.actor, "owner", "chat.postMessage used the wrong person's user token");
    equal(writeCall?.authKind, "user", "chat.postMessage used a bot token");

    for (const [index, account] of [[0, memberAccount], [1, ownerAccount]]) {
      const search = yield* Effect.promise(() => nativeClients[index].callTool({ name: "search", arguments: { query: "Slack" } }));
      check(!textOf(search).includes(account), "Native search discovered a peer account");
    }

    const observations = mock.observations();
    equal(observations.api.filter((item) => item.operation === "auth.test").length, 2,
      "Slack auth.test did not validate both personal accounts");
    check(observations.api.some((item) => item.operation === "conversations.history"),
      "The vendor OpenAPI history operation did not reach Slack");
    check(observations.exchanges.length === 2, "Slack user OAuth did not exchange both codes");
    check(observations.authorization.length === 2, "Expected one UI OAuth and one second-person OAuth");
    for (const auth of observations.authorization) {
      equal(auth.scope ?? "", "", "Slack authorization requested bot scope");
      equal(auth.userScope, observations.authorization[0].userScope, "Slack user_scope changed between sign-ins");
    }
    check(observations.exchanges.every((entry) => entry.clientAuth === "client_secret_post"),
      "Slack OAuth did not use the hosted client's auth method");
    check(observations.api.filter((entry) => ["auth.test", "conversations.history", "chat.postMessage"].includes(entry.operation))
      .every((entry) => entry.authKind === "user"), "A Slack API call used a bot or missing token");
    check(!observations.api.some((entry) => entry.authKind === "bot"), "The top-level Slack bot token reached the API");
    check(observations.catalog.some((entry) => entry.path === "/catalog/apps/slack.json"), "The catalog did not serve the local maintained package");
    check(observations.catalog.some((entry) => entry.path === "/catalog/specs/slack-openapi.json"), "The host did not load the local vendor OpenAPI fixture");

    const modelProof = yield* Effect.promise(() => proveInstalledClaude({
      root,
      directory,
      origin: target.metadata.origin,
      token: issued[0].key,
      slug: app.slug,
      historyPath,
      postPath,
      marker: "synthetic_owner_history",
      peerMarker: "synthetic_member_history",
      channel: "C_SYNTHETIC",
      postText: "synthetic_owner_post",
      mock,
    }));
    check(modelProof.installedClaude && modelProof.installedClaudeRead && modelProof.installedClaudePost,
      "Installed Claude did not complete its Slack read and post through MCP");
    return modelProof;
  });
}
