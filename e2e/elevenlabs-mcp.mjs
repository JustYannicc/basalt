import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";

export const mcpPayload = (result) => {
  assert.equal(result.isError ?? false, false);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
};

/** The management MCP endpoint must discover and run both account-bound transports. */
export const proveElevenLabsMcp = ({
  upstream,
  origin,
  organization,
  slug,
  request,
  token,
  oauth,
  check,
}) =>
  Effect.gen(function* () {
    const key = yield* request("POST", "/api/auth/api-key/create", {
      name: "ElevenLabs proof",
      metadata: { organization },
    });
    yield* Effect.addFinalizer(() =>
      request("POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.as(undefined)),
    );
    const require = createRequire(join(upstream, "package.json"));
    const { Client } = yield* Effect.promise(
      () =>
        import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href),
    );
    const { StreamableHTTPClientTransport } = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href
        ),
    );
    const client = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const client = new Client({ name: "elevenlabs-proof", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: {
              headers: {
                authorization: `Bearer ${key.key}`,
                "X-Executor-Organization": organization,
              },
            },
          }),
        );
        return client;
      }),
      (client) => Effect.promise(() => client.close()),
    );
    for (const [name, accountId, expected] of [
      ["fixture_read", token, { transport: "rest", marker: "retained-token" }],
      ["list_voices", oauth, { transport: "mcp", marker: "list_voices" }],
    ]) {
      const search = yield* Effect.promise(() =>
        client.callTool({ name: "search", arguments: { query: name, namespace: slug } }),
      );
      const item = search.structuredContent?.items?.find((item) => item.path.endsWith(`.${name}`));
      assert.ok(item, `MCP search must find ${name}`);
      const called = yield* Effect.promise(() =>
        client.callTool({
          name: "call",
          arguments: {
            calls: { path: item.path, input: { accountId, input: {} } },
          },
        }),
      );
      check(`MCP ${name} executes`, called.structuredContent?.execution?.ok, true);
      check(`MCP ${name} succeeds`, called.structuredContent?.execution?.value?.ok, true);
      const output = called.structuredContent.execution.value.value;
      check(
        `MCP ${name} returns its upstream result`,
        Array.isArray(output?.content) ? mcpPayload(output) : output,
        expected,
      );
    }
  });
