import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { command, launch } from "./support.ts";
import { ready } from "./native-client-fixture.ts";

test(
  "direct CLI model queries stay on allowed paths over HTTP and WebSocket",
  { timeout: 15_000 },
  async () => {
    const paths: string[] = [];
    const remote = createServer((request, response) => {
      assert.equal(request.headers.authorization, "Bearer synthetic-model-key");
      paths.push(request.url!);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ target: request.url }));
    });
    const sockets = new WebSocketServer({ noServer: true });
    remote.on("upgrade", (request, socket, head) => {
      assert.equal(request.headers.authorization, "Bearer synthetic-model-key");
      paths.push(request.url!);
      sockets.handleUpgrade(request, socket, head, (peer) => {
        peer.on("message", () => peer.send(request.url!));
      });
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    const address = remote.address();
    assert.ok(address && typeof address !== "string");
    const home = await mkdtemp(join(tmpdir(), "client-model-query-"));
    let runtime: ReturnType<typeof launch> | undefined;
    try {
      const input = join(home, "input.json");
      await writeFile(
        input,
        JSON.stringify({
          version: 1,
          mode: "direct",
          models: { origin: `http://127.0.0.1:${address.port}`, token: "synthetic-model-key" },
        }),
        { mode: 0o600 },
      );
      await command(
        ["import-direct", input, "--storage", process.platform === "linux" ? "file" : "os"],
        home,
      );
      await command(["agent", "add", "query", "models"], home);
      const { token } = JSON.parse(await readFile(join(home, "agent-query.json"), "utf8"));
      runtime = launch(["run"], home);
      await ready(runtime, /Connection ready at /u);
      const { origin } = JSON.parse(await readFile(join(home, "runtime.json"), "utf8"));
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      for (const [method, path, search] of [
        ["GET", "/v1/models", "?client_version=0.166.0"],
        ["POST", "/v1/messages", "?beta=true"],
        ["GET", "/v1/models", "?label=two%20words"],
      ]) {
        const response = await fetch(`${origin}${path}${search}`, {
          method,
          headers,
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          target: `${path}${search!.replace("%20", "+")}`,
        });
      }
      const websocket = new WebSocket(
        origin.replace("http:", "ws:") + "/v1/responses?label=two%20words",
        { headers },
      );
      websocket.on("error", () => {});
      try {
        await once(websocket, "open");
        const message = once(websocket, "message");
        websocket.send("target");
        const [bytes] = await message;
        assert.equal(bytes.toString(), "/v1/responses?label=two+words");
        const closed = once(websocket, "close");
        websocket.close();
        await closed;
      } finally {
        websocket.terminate();
      }
      const before = paths.length;
      for (const path of [
        "/v1/models?bad=%GG",
        "/v1/models?value=" + "x".repeat(2048),
        "/mcp?beta=true",
        "/api/organizations?beta=true",
      ]) {
        const response = await fetch(`${origin}${path}`, { headers });
        assert.equal(response.status, 404);
        await response.body?.cancel();
      }
      assert.equal(paths.length, before, "Refused queries never reach the remote server.");
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
