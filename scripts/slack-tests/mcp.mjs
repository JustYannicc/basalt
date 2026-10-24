import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Effect } from "effect";
import { proveInstalledClaude } from "./native-claude.mjs";

const textOf = (value) => JSON.stringify(value?.structuredContent ?? value?.content ?? value);
const slackPostCount = (mock) => mock.observations().api.filter((item) => item.operation === "chat.postMessage").length;
const slackApiCount = (mock) => mock.observations().api.length;
const channel = "C000000001";
const syntheticUserToken = (actor) => `xoxp-synthetic-${actor}`;

function toolItem(items, parts, operation) {
  const item = items?.find((candidate) => {
    const normalized = candidate.path.toLowerCase().replace(/[^a-z0-9]/g, "");
    return parts.every((part) => normalized.includes(part));
  });
  if (!item) throw new Error(`OpenAPI search did not return ${operation}`);
  return item;
}

function selectedAccountId(result, item, schemaKey, expected, peer, label, check, equal) {
  const namespace = result.structuredContent?.namespaces?.find(
    (entry) => entry.path === "tools.slack" && entry.app === "Slack",
  );
  check(typeof namespace?.accounts === "string", `${label} did not return the Slack account namespace`);
  const schema = item[schemaKey];
  check(typeof schema === "string", `${label} did not return the ${schemaKey} account signature`);
  const accountId = /accountId:\s*["']([^"']+)["']/.exec(schema)?.[1];
  check(typeof accountId === "string", `${label} did not name the selected accountId`);
  equal(accountId, expected, `${label} selected the wrong personal Slack account`);
  check(namespace.accounts.includes(accountId), `${label} namespace omitted its selected Slack account`);
  check(!namespace.accounts.includes(peer), `${label} namespace exposed the peer Slack account`);
  check(!schema.includes(peer), `${label} signature exposed the peer Slack account`);
  return accountId;
}

function operationSucceeded(result) {
  const execution = result?.structuredContent?.execution;
  return result?.isError === false && execution?.ok === true && execution.value?.ok === true;
}

function isAccountInputInvalid(result) {
  const execution = result?.structuredContent?.execution;
  const value = execution?.value;
  const error = value?.error;
  return result?.isError === false
    && execution?.ok === true
    && value?.ok === false
    && error?.kind === "ToolFailure"
    && error.response?.code === "InputInvalid"
    && error.response?.status === 422;
}

function executeCall(path, input) {
  return `return await ${path}(JSON.parse(${JSON.stringify(JSON.stringify(input))}));`;
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
    const callMcp = async (client, request) => {
      const result = await client.callTool(request);
      appendFileSync(join(directory, "mcp-responses.jsonl"), `${JSON.stringify({ request, result })}\n`, { mode: 0o600 });
      return result;
    };
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
    let ownerHistoryAccountId;
    let ownerPostAccountId;
    for (const [index, client] of nativeClients.entries()) {
      const peerAccount = index === 0 ? memberAccount : ownerAccount;
      const ownAccount = index === 0 ? ownerAccount : memberAccount;
      const ownMarker = index === 0 ? "synthetic_owner_history" : "synthetic_member_history";
      const peerMarker = index === 0 ? "synthetic_member_history" : "synthetic_owner_history";
      const search = yield* Effect.promise(() => callMcp(client, { name: "search", arguments: { query: "conversations.history" } }));
      check(!search.isError, "Native MCP could not search Slack OpenAPI tools");
      const searchText = textOf(search);
      check(!searchText.includes(peerAccount), "Native MCP exposed the peer account during discovery");
      const historyTool = toolItem(search.structuredContent?.items ?? [], ["conversations", "history"], "conversations.history");
      const currentHistory = historyTool.path;
      const historyAccountId = selectedAccountId(search, historyTool, "input", ownAccount, peerAccount, "History search", check, equal);
      const secondSearch = yield* Effect.promise(() => callMcp(client, { name: "search", arguments: { query: "chat.postMessage" } }));
      check(!secondSearch.isError, "Native MCP could not search for chat.postMessage");
      const postTool = toolItem(secondSearch.structuredContent?.items ?? [], ["chat", "postmessage"], "chat.postMessage");
      const currentPost = postTool.path;
      const postAccountId = selectedAccountId(secondSearch, postTool, "input", ownAccount, peerAccount, "chat.postMessage search", check, equal);
      historyPath ??= currentHistory;
      if (postPath === undefined) postPath = currentPost;
      else equal(currentPost, postPath, "Slack clients did not discover the same chat.postMessage operation");

      const described = yield* Effect.promise(() => callMcp(client, { name: "describe", arguments: { paths: [currentHistory, currentPost] } }));
      check(!described.isError && !textOf(described).includes(peerAccount), "Native describe exposed peer account details");
      const describedHistory = toolItem(described.structuredContent?.items ?? [], ["conversations", "history"], "described conversations.history");
      const describedPost = toolItem(described.structuredContent?.items ?? [], ["chat", "postmessage"], "described chat.postMessage");
      equal(selectedAccountId(described, describedHistory, "signature", ownAccount, peerAccount, "History describe", check, equal), historyAccountId,
        "History search and describe selected different Slack accounts");
      equal(selectedAccountId(described, describedPost, "signature", ownAccount, peerAccount, "chat.postMessage describe", check, equal), postAccountId,
        "chat.postMessage search and describe selected different Slack accounts");
      if (index === 0) {
        ownerHistoryAccountId = historyAccountId;
        ownerPostAccountId = postAccountId;
      }

      const historyInput = { accountId: historyAccountId, input: { query: { channel } } };
      const read = yield* Effect.promise(() => callMcp(client, { name: "call", arguments: {
        calls: { path: currentHistory, input: historyInput },
      } }));
      const readText = textOf(read);
      check(operationSucceeded(read) && readText.includes(ownMarker) && !readText.includes(peerMarker),
        "Native MCP history call did not return the caller's Slack messages");

      const executedRead = yield* Effect.promise(() => callMcp(client, { name: "execute", arguments: {
        code: `return await ${currentHistory}(${JSON.stringify(historyInput)});`,
      } }));
      const executedReadText = textOf(executedRead);
      check(operationSucceeded(executedRead) && executedReadText.includes(ownMarker) && !executedReadText.includes(peerMarker),
        "MCP execute history call did not return the caller's Slack messages");

      const peerHistoryInput = { accountId: peerAccount, input: { query: { channel } } };
      const apiBeforePeerRead = slackApiCount(mock);
      const peerRead = yield* Effect.promise(() => callMcp(client, { name: "call", arguments: {
        calls: { path: currentHistory, input: peerHistoryInput },
      } }));
      check(isAccountInputInvalid(peerRead), "Native MCP call did not reject the peer account with SDK InputInvalid (422)");
      equal(slackApiCount(mock), apiBeforePeerRead, "Rejected peer-account history call reached Slack");

      const peerReadExecute = yield* Effect.promise(() => callMcp(client, { name: "execute", arguments: {
        code: executeCall(currentHistory, peerHistoryInput),
      } }));
      check(isAccountInputInvalid(peerReadExecute), "MCP execute did not reject the peer account with SDK InputInvalid (422)");
      equal(slackApiCount(mock), apiBeforePeerRead, "Rejected peer-account history execute reached Slack");

      const peerWriteInput = {
        accountId: peerAccount,
        input: {
          contentType: "application/x-www-form-urlencoded",
          body: { channel, text: `synthetic_forbidden_${index}_post` },
          headers: { token: syntheticUserToken(index === 0 ? "member" : "owner") },
        },
      };
      const apiBeforePeerWrite = slackApiCount(mock);
      const peerWrite = yield* Effect.promise(() => callMcp(client, { name: "call", arguments: {
        calls: { path: currentPost, input: peerWriteInput },
      } }));
      check(isAccountInputInvalid(peerWrite), "Native MCP call did not reject peer chat.postMessage with SDK InputInvalid (422)");
      equal(slackApiCount(mock), apiBeforePeerWrite, "Rejected peer-account chat.postMessage call reached Slack");
      const peerExecute = yield* Effect.promise(() => callMcp(client, { name: "execute", arguments: {
        code: executeCall(currentPost, peerWriteInput),
      } }));
      check(isAccountInputInvalid(peerExecute), "MCP execute did not reject peer chat.postMessage with SDK InputInvalid (422)");
      equal(slackApiCount(mock), apiBeforePeerWrite, "Rejected peer-account chat.postMessage execute reached Slack");

      const sessionActor = index === 0 ? actors.owner : actors.member;
      const inspectPeer = yield* request(sessionActor, "GET", `${prefix}/accounts/${peerAccount}`);
      check(inspectPeer.status === 403 || inspectPeer.status === 404, "A person could read the peer account record");
      const linkPeer = yield* request(sessionActor, "PUT",
        `${prefix}/apps/${app.id}/accounts/user/slack/${encodeURIComponent(peerAccount)}`);
      check(linkPeer.status === 403 || linkPeer.status === 404, "A person could link the peer account");
    }

    const nativeTools = yield* Effect.promise(() => nativeClients[0].listTools());
    const callToolDefinition = nativeTools.tools.find((tool) => tool.name === "call");
    check(callToolDefinition?.annotations?.readOnlyHint === false
      && callToolDefinition?.annotations?.destructiveHint === true
      && callToolDefinition?.annotations?.openWorldHint === true,
    "Native MCP call did not carry caller approval annotations");
    const writeInput = {
      accountId: ownerPostAccountId,
      input: {
        contentType: "application/x-www-form-urlencoded",
        body: { channel, text: "synthetic_owner_post" },
        headers: { token: syntheticUserToken("owner") },
      },
    };
    const callsBeforeApproval = slackPostCount(mock);
    const executeWrite = yield* Effect.promise(() => callMcp(standard, { name: "execute", arguments: {
      code: `return await ${postPath}(${JSON.stringify(writeInput)});`,
    } }));
    const pendingText = textOf(executeWrite);
    check(pendingText.includes("approval-required") || pendingText.includes("ToolApprovalRequired"),
      "The maintained mutation approval flow did not pause chat.postMessage");
    equal(slackPostCount(mock),
      callsBeforeApproval, "chat.postMessage reached Slack before approval");
    const posted = yield* Effect.promise(() => callMcp(nativeClients[0], { name: "call", arguments: {
      calls: { path: postPath, input: writeInput },
    } }));
    check(operationSucceeded(posted) && textOf(posted).includes("synthetic_owner_post"), "Native MCP did not post as the caller");
    equal(slackPostCount(mock), callsBeforeApproval + 1,
      "The approved native MCP write did not reach Slack exactly once");
    const writeCall = mock.observations().api.filter((item) => item.operation === "chat.postMessage").at(-1);
    equal(writeCall?.actor, "owner", "chat.postMessage used the wrong person's user token");
    equal(writeCall?.authKind, "user", "chat.postMessage used a bot token");

    for (const [index, account] of [[0, memberAccount], [1, ownerAccount]]) {
      const search = yield* Effect.promise(() => callMcp(nativeClients[index], { name: "search", arguments: { query: "Slack" } }));
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
      historyAccountId: ownerHistoryAccountId,
      postAccountId: ownerPostAccountId,
      peerAccountId: memberAccount,
      userToken: syntheticUserToken("owner"),
      marker: "synthetic_owner_history",
      peerMarker: "synthetic_member_history",
      channel,
      postText: "synthetic_owner_post",
      mock,
    }));
    check(modelProof.installedClaude && modelProof.installedClaudeRead && modelProof.installedClaudePost,
      "Installed Claude did not complete its Slack read and post through MCP");
    return modelProof;
  });
}
