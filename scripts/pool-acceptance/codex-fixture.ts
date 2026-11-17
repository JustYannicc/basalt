import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedModelPeer } from "../../clients/e2e/installed-model-peer.ts";
import { isObject } from "./types.ts";

export const codexFixtureModel = "gpt-5.4";

function syntheticJwt() {
  return (
    [
      { alg: "RS256", typ: "JWT" },
      {
        sub: "preview-fixture",
        email: "preview@example.invalid",
        exp: Math.floor(Date.now() / 1000) + 86_400,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "preview-fixture",
          chatgpt_user_id: "preview-fixture",
          chatgpt_plan_type: "plus",
        },
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".") + ".synthetic"
  );
}

function response(
  model: string,
  marker: string,
  tool?: { name: string; namespace?: string },
  warmup = false,
) {
  const item = tool
    ? {
        type: "function_call",
        id: "fc_preview",
        call_id: "call_preview",
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        arguments: '{"query":"pool","limit":1}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_preview",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: marker, annotations: [] }],
      };
  const completed = {
    id: "resp_preview",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: warmup ? [] : [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
  ];
  if (!warmup) {
    events.push({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    });
    events.push(
      tool
        ? {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            arguments: '{"query":"pool","limit":1}',
          }
        : {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: marker,
          },
    );
    events.push({ type: "response.output_item.done", output_index: 0, item });
  }
  events.push({ type: "response.completed", response: completed });
  return new Response(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Only Responses is synthetic. The installed Codex CLI still calls the preview's real MCP endpoint. */
export async function openCodexPreviewFixture(marker: string, serverName: string) {
  const root = await mkdtemp(join(tmpdir(), "preview-codex-fixture-"));
  await chmod(root, 0o700);
  const jwt = syntheticJwt();
  const modelKey = randomBytes(32).toString("hex");
  const authFile = join(root, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: "synthetic-refresh-token-must-remain-untouched",
          account_id: "preview-fixture",
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  let requests = 0;
  let toolRequested = false;
  let toolResultObserved = false;
  let failed = false;
  const respond = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (
      path === "/v1/models" &&
      request.method === "GET" &&
      request.headers.get("x-api-key") === modelKey
    ) {
      return Response.json({ models: [] });
    }
    if (
      path !== "/v1/responses" ||
      request.method !== "POST" ||
      request.headers.get("x-api-key") !== modelKey ||
      request.headers.get("authorization") !== `Bearer ${jwt}`
    )
      return new Response(null, { status: 401 });
    const body: unknown = await request.json();
    if (!isObject(body) || body.model !== codexFixtureModel)
      return new Response(null, { status: 400 });
    if (body.generate === false) return response(codexFixtureModel, marker, undefined, true);
    requests++;
    if (requests > 4 || !Array.isArray(body.input)) return new Response(null, { status: 400 });
    if (!toolRequested) {
      const definitions = Array.isArray(body.tools) ? body.tools : [];
      const direct = definitions.find(
        (tool) =>
          isObject(tool) && tool.type === "function" && tool.name === `mcp__${serverName}__search`,
      );
      const namespace = definitions.find(
        (tool) => isObject(tool) && tool.type === "namespace" && tool.name === `mcp__${serverName}`,
      );
      const tool = isObject(direct)
        ? { name: String(direct.name) }
        : isObject(namespace) &&
            Array.isArray(namespace.tools) &&
            namespace.tools.some((value) => isObject(value) && value.name === "search")
          ? { name: "search", namespace: String(namespace.name) }
          : undefined;
      if (!tool) return new Response(null, { status: 400 });
      toolRequested = true;
      return response(codexFixtureModel, marker, tool);
    }
    toolResultObserved = body.input.some(
      (item) =>
        isObject(item) && item.type === "function_call_output" && item.call_id === "call_preview",
    );
    if (!toolResultObserved) return new Response(null, { status: 400 });
    return response(codexFixtureModel, marker);
  };
  const server = createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw 0;
        chunks.push(Buffer.from(chunk));
      }
      const result = await respond(
        new Request(new URL(request.url ?? "/", "http://127.0.0.1"), {
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value]] : [],
            ),
          ),
          ...(request.method !== "GET" && request.method !== "HEAD"
            ? { body: Buffer.concat(chunks) }
            : {}),
        }),
      );
      reply.writeHead(result.status, Object.fromEntries(result.headers));
      reply.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      failed = true;
      reply.writeHead(500);
      reply.end();
    }
  });
  const peer = installedModelPeer(server, modelKey, jwt, respond, () => {
    failed = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw 0;
    const origin = new URL("http://127.0.0.1");
    origin.port = String(address.port);
    return {
      modelUrl: origin.origin,
      modelKey,
      authFile,
      model: codexFixtureModel,
      evidence: () => ({ requests, toolRequested, toolResultObserved, failed }),
      async close() {
        peer.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch {
    peer.close();
    server.close();
    await rm(root, { recursive: true, force: true });
    throw new Error("Codex preview fixture could not start");
  }
}
