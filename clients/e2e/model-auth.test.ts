import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { command, launch } from "./support.ts";
import { ready } from "./native-client-fixture.ts";

test(
  "model API keys authenticate locally and preserve provider login without granting tools or controls",
  { timeout: 15_000 },
  async () => {
    const observed: { key: string | undefined; authorization: string | undefined }[] = [];
    const remoteKey = "synthetic-remote-model-key",
      providerLogin = "Bearer synthetic.provider.login";
    const observe = (incoming: import("node:http").IncomingMessage) => {
      const key = incoming.headers["x-api-key"];
      assert.ok(key === undefined || typeof key === "string");
      const entry = { key, authorization: incoming.headers.authorization };
      observed.push(entry);
      assert.equal(key, remoteKey, "The local model key is replaced before forwarding.");
      return entry;
    };
    const remote = createServer((incoming, response) => {
      const entry = observe(incoming);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(entry));
    });
    const sockets = new WebSocketServer({ noServer: true });
    remote.on("upgrade", (incoming, socket, head) => {
      const entry = observe(incoming);
      sockets.handleUpgrade(incoming, socket, head, (peer) => {
        peer.on("message", () => peer.send(JSON.stringify(entry)));
      });
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    const address = remote.address();
    assert.ok(address && typeof address !== "string");
    const home = await mkdtemp(join(tmpdir(), "client-model-auth-"));
    let runtime: ReturnType<typeof launch> | undefined;
    try {
      const input = join(home, "input.json");
      await writeFile(
        input,
        JSON.stringify({
          version: 1,
          mode: "direct",
          models: { origin: `http://127.0.0.1:${address.port}`, token: remoteKey },
        }),
        { mode: 0o600 },
      );
      await command(
        ["import-direct", input, "--storage", process.platform === "linux" ? "file" : "os"],
        home,
      );
      await command(["agent", "add", "model", "models"], home);
      await command(["agent", "add", "tools", "tools"], home);
      const token = async (id: string): Promise<string> =>
        JSON.parse(await readFile(join(home, `agent-${id}.json`), "utf8")).token;
      const model = await token("model"),
        tools = await token("tools");
      runtime = launch(["run"], home);
      await ready(runtime, /Connection ready at /u);
      const { origin } = JSON.parse(await readFile(join(home, "runtime.json"), "utf8"));
      for (const authorization of [undefined, providerLogin, `Bearer ${model}`]) {
        const headers = { "x-api-key": model, ...(authorization ? { authorization } : {}) };
        const response = await fetch(`${origin}/v1/models?client_version=0.166.0`, { headers });
        assert.equal(response.status, 200);
        const expected = {
          key: remoteKey,
          ...(authorization === providerLogin ? { authorization } : {}),
        };
        assert.deepEqual(await response.json(), expected);
        const websocket = new WebSocket(origin.replace("http:", "ws:") + "/v1/responses", {
          headers,
        });
        websocket.on("error", () => {});
        try {
          await once(websocket, "open");
          const received = once(websocket, "message");
          websocket.send("headers");
          assert.deepEqual(JSON.parse((await received)[0].toString()), expected);
          const closed = once(websocket, "close");
          websocket.close();
          await closed;
        } finally {
          websocket.terminate();
        }
      }
      const before = observed.length;
      for (const [path, headers] of [
        ["/v1/models", { "x-api-key": "invalid", authorization: `Bearer ${model}` }],
        ["/v1/models", { "x-api-key": tools }],
        ["/mcp", { "x-api-key": model }],
        ["/client/status", { "x-api-key": model }],
      ] as const) {
        const response = await fetch(`${origin}${path}`, { headers });
        assert.equal(response.status, 401);
        await response.body?.cancel();
      }
      const url = new URL(origin);
      const duplicate = await new Promise<number>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/v1/models",
            headers: ["Host", url.host, "X-Api-Key", model, "X-Api-Key", model],
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
      assert.equal(duplicate, 403);
      assert.equal(
        observed.length,
        before,
        "Refused local credentials never reach the remote service.",
      );
      assert.ok(
        observed.every((entry) => entry.key !== model && entry.authorization !== `Bearer ${model}`),
      );
    } finally {
      if (runtime) {
        await command(["sign-out"], home).catch(() => undefined);
        runtime.child.kill("SIGTERM");
        await runtime.exited;
      }
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      remote.closeAllConnections();
      await new Promise<void>((resolve) => remote.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
