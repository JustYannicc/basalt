import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export const nativeMarker = "atlassian-native-mcp-proof-ok";
export const nativeModelKey = "synthetic-atlassian-model-key";
export const nativeModelName = "gpt-5.4";

function containsText(value, expected, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (value.includes(expected)) return true;
    const output = value.match(/(?:^|\n)Output:\n([\s\S]*)$/);
    if (output && containsText(output[1].trim(), expected, depth + 1)) return true;
    try { return containsText(JSON.parse(value), expected, depth + 1); } catch { return false; }
  }
  return typeof value === "object" && Object.values(value).some((item) => containsText(item, expected, depth + 1));
}

function anthropic(model, tool, input, turn) {
  const events = [
    { type: "message_start", message: { id: "msg_atlassian", type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: `tool_${tool}_${turn}`, name: tool, input: {} }
      : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify(input) }
      : { type: "text_delta", text: nativeMarker } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function codexResponse(model, tool, input, namespace, turn) {
  const item = tool
    ? { type: "function_call", id: `fc_${tool}_${turn}`, call_id: `call_${tool}_${turn}`, name: tool,
      ...(namespace ? { namespace } : {}), arguments: JSON.stringify(input), status: "completed" }
    : { type: "message", id: "msg_atlassian", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: nativeMarker, annotations: [] }] };
  const response = { id: `resp_${tool ?? "final"}_${turn}`, object: "response", created_at: Math.floor(Date.now() / 1000),
    model, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
  ];
  if (tool) events.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0,
    arguments: item.arguments });
  else events.push({ type: "response.output_text.delta", item_id: item.id, output_index: 0,
    content_index: 0, delta: nativeMarker });
  events.push({ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response });
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function codexTool(body, name) {
  for (const entry of body.tools ?? []) {
    if (entry.type === "namespace" && entry.name === "mcp__signalbox") {
      const tool = entry.tools?.find((candidate) => candidate.name === name);
      if (tool) return { name: tool.name, namespace: entry.name };
    }
    if (entry.name === `mcp__signalbox__${name}`) return { name: entry.name };
  }
}

/** Model API fixture that answers only local Claude and Codex MCP turns. */
export async function startNativeModelFixture({ toolPaths, person, peer }) {
  const trace = [];
  const failures = [];
  let turns = 0;
  let searchReturned = false;
  let confluenceReturned = false;
  let jiraReturned = false;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/hello" && request.method === "HEAD") {
      response.writeHead(200); response.end(); return;
    }
    if (path === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: nativeModelName, object: "model", created: 1, owned_by: "fixture" }] }));
      return;
    }
    if (!["/v1/messages", "/v1/responses"].includes(path) || request.method !== "POST") {
      response.writeHead(404); response.end(); return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (path === "/v1/messages") assert.equal(request.headers.authorization, `Bearer ${nativeModelKey}`);
      else {
        assert.equal(request.headers["x-api-key"], nativeModelKey);
        assert.ok((request.headers.authorization ?? "").includes("synthetic-codex-jwt"));
      }
      turns++;
      assert.ok(turns <= 4, "Native model exceeded four turns");
      const resultRecords = path === "/v1/messages"
        ? (body.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : [])
          .filter((content) => content.type === "tool_result")
          .map((content) => ({ id: content.tool_use_id, isError: content.is_error === true, content: content.content }))
        : (body.input ?? []).filter((item) => item.type === "function_call_output")
          .map((item) => ({ id: item.call_id, isError: item.is_error === true, content: item.output }));
      trace.push({
        path,
        turn: turns,
        model: body.model,
        bearer: request.headers.authorization === `Bearer ${nativeModelKey}`,
        apiKey: request.headers["x-api-key"] === nativeModelKey,
        syntheticCodexAuth: (request.headers.authorization ?? "").includes("synthetic-codex-jwt"),
        ...(turns >= 2 ? { toolResults: resultRecords } : {}),
      });

      const claudeTools = body.tools ?? [];
      if (turns === 2) {
        searchReturned = resultRecords.some((result) => !result.isError
          && containsText(result.content, toolPaths.searchConfluence));
        assert.ok(searchReturned, "Signalbox search did not return the catalog tool path to the native model");
      }
      if (turns === 3) {
        confluenceReturned = resultRecords.some((result) => !result.isError
          && containsText(result.content, person.pageMarker));
        assert.ok(confluenceReturned, "Confluence search result did not return to the native model");
        assert.ok(!containsText(resultRecords.map((result) => result.content), peer.pageMarker),
          "Confluence result included the peer account marker");
      }
      if (turns === 4) {
        jiraReturned = resultRecords.some((result) => !result.isError
          && containsText(result.content, person.jiraMarker));
        assert.ok(jiraReturned, "Jira issue result did not return to the native model");
        assert.ok(!containsText(resultRecords.map((result) => result.content), peer.jiraMarker),
          "Jira result included the peer account marker");
      }

      let name, namespace, input;
      if (turns === 1) {
        if (path === "/v1/messages") name = claudeTools.find((tool) => tool.name === "mcp__signalbox__search")?.name;
        else ({ name, namespace } = codexTool(body, "search") ?? {});
        assert.ok(name, "Native CLI did not load Signalbox search");
        input = { query: "atlassian" };
      } else if (turns === 2) {
        if (path === "/v1/messages") name = claudeTools.find((tool) => tool.name === "mcp__signalbox__call")?.name;
        else ({ name, namespace } = codexTool(body, "call") ?? {});
        assert.ok(name, "Native CLI did not load Signalbox call");
        input = { calls: { path: toolPaths.searchConfluence, input: {
          cloudId: person.cloudId, cql: person.cql, limit: 5,
        } } };
      } else if (turns === 3) {
        if (path === "/v1/messages") name = claudeTools.find((tool) => tool.name === "mcp__signalbox__call")?.name;
        else ({ name, namespace } = codexTool(body, "call") ?? {});
        assert.ok(name, "Native CLI did not load Signalbox call for Jira");
        input = { calls: { path: toolPaths.getJiraIssue, input: {
          cloudId: person.cloudId, issueKey: person.issueKey,
        } } };
      }

      const result = path === "/v1/messages"
        ? anthropic(body.model, name, input, turns)
        : codexResponse(body.model, name, input, namespace, turns);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      failures.push(String(error));
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"local model fixture assertion failed"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Native model fixture did not bind a loopback port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    trace,
    failures,
    complete: () => searchReturned && confluenceReturned && jiraReturned && turns === 4,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
