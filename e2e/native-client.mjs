import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../.upstream/e2e/support/managed-server.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { lockedNpmRegistry } from "../.upstream/e2e/support/npm-registry.ts";
import { nativePool } from "../.upstream/e2e/support/native-pool.ts";
import { appsManifest } from "../.upstream/e2e/support/apps-release.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";
import { startNativeClientWorker } from "./native-client-worker.mjs";
import { nativeClientCli } from "./native-client-cli.mjs";
import { nativeSlowReader } from "./native-client-reader.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const upstream = join(root, ".upstream");
const clientRequire = createRequire(join(root, "clients/package.json"));
const { WebSocket } = clientRequire("ws");
const { Client } = await import(
  pathToFileURL(clientRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(clientRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href
);
await mkdir(join(root, ".generated"), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, ".generated/native-client-"));
const home = join(directory, "profile");
await mkdir(home, { mode: 0o700 });
process.chdir(upstream);
const storage = process.platform === "linux" ? "file" : "os";
const { launch, ready, command, start, stop } = nativeClientCli(root, home);
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
const program = Effect.gen(function* () {
  const worker = yield* Effect.acquireRelease(
    Effect.promise(() => startNativeClientWorker(root)),
    (worker) => Effect.promise(worker.close),
  );
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const prepared = yield* prepareScenario(
    base.target,
    "Native client through the real Router and hosted grant",
  );
  const target = Target.of({
    ...prepared,
    metadata: { ...prepared.metadata, origin: worker.origin },
  });
  const secret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target,
      authSecret: secret,
      directory,
      organization: "native-client",
      namePrefix: "native-client",
    }),
  );
  const pool = yield* nativePool(actors.organization.id, "pool-native-client");
  const registry = yield* lockedNpmRegistry;
  const backend = `http://127.0.0.1:${yield* Effect.promise(freePort)}`;
  worker.connect(backend, pool);
  yield* startManagedServer(target, "product", {
    PORT: new URL(backend).port,
    EXECUTOR_PORT: new URL(backend).port,
    BETTER_AUTH_URL: worker.origin,
    BETTER_AUTH_SECRET: secret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    BASALT_POOL_ORIGIN: pool.origin,
  });
  yield* Effect.promise(async () => {
    const owner = {
      cookie: actors.owner.headers.cookie,
      origin: worker.origin,
      "content-type": "application/json",
    };
    const receipt = randomBytes(12).toString("hex");
    const deployed = await fetch(
      `${worker.origin}/api/organizations/${actors.organization.id}/apps/deploy`,
      {
        method: "POST",
        headers: owner,
        body: JSON.stringify({
          name: "Native client proof",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, object, query, router } from "apps"; export default defineApp({}, { tools: router({ echo: query({ input: object({}) }, async () => ({ receipt: ${JSON.stringify(receipt)} })) }) });`,
            },
            appsManifest,
          ],
        }),
      },
    );
    assert.equal(deployed.status, 200);
    const app = await deployed.json();
    try {
      const login = launch(["login", worker.origin, "--no-browser", "--storage", storage]);
      const match = await ready(login, /Confirmation code: ([A-Z-]+)/u);
      const approval = await fetch(`${worker.origin}/api/auth/device/decide`, {
        method: "POST",
        headers: {
          ...owner,
          "x-basalt-native-intent": "approved-native-intent",
          "x-basalt-native-name": "Native CLI proof",
          "x-basalt-native-pool": "pool-native-client",
          "x-basalt-native-models": "true",
          "x-basalt-native-tools": "true",
        },
        body: JSON.stringify({ user_code: match[1], accept: true }),
      });
      assert.equal(approval.status, 200);
      const signedIn = await login.exited;
      assert.equal(signedIn.code, 0);
      assert.ok(
        !signedIn.stdout.includes("access_token") && !signedIn.stderr.includes("refresh_token"),
      );
      await command(["agent", "add", "proof", "models", "tools"]);
      let origin = await start();
      const firstOrigin = origin;
      assert.equal(worker.refreshes(), 1, "The native CLI renews the actual hosted grant once.");
      const token = JSON.parse(await readFile(join(home, "agent-proof.json"), "utf8")).token;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "synthetic-model", stream: true }),
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/u);
      worker.complete();
      let tail = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        tail += new TextDecoder().decode(next.value);
      }
      assert.match(tail, /data: complete/u);
      let backpressure;
      const client = new Client({ name: "native-client-proof", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers } }),
        );
        const call = () =>
          client.callTool({
            name: "execute",
            arguments: { code: `return await tools[${JSON.stringify(app.slug)}].echo({})` },
          });
        const verifyTool = async () => {
          assert.ok(
            JSON.stringify(await call()).includes(receipt),
            "A real deployed tool returns its unique receipt through the native CLI.",
          );
        };
        await verifyTool();
        backpressure = await nativeSlowReader(origin, headers, worker, verifyTool);
      } finally {
        await client.close();
      }
      const socket = new WebSocket(origin.replace("http:", "ws:") + "/v1/responses", { headers });
      await once(socket, "open");
      for (const [value, binary] of [
        [Buffer.alloc(50000, 137), true],
        [Buffer.alloc(0), false],
      ]) {
        const echoed = once(socket, "message");
        socket.send(value, { binary });
        const [actual, isBinary] = await echoed;
        assert.deepEqual(actual, value);
        assert.equal(isBinary, binary);
      }
      const finalMessage = once(socket, "message"),
        socketClosed = once(socket, "close");
      socket.send("close-with-output");
      assert.equal((await finalMessage)[0].toString(), "retained-after-close");
      await socketClosed;
      const cancellation = worker.nextCancellation();
      const controller = new AbortController();
      const active = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: "{}",
      });
      const activeReader = active.body.getReader();
      await activeReader.read();
      controller.abort();
      await activeReader.cancel().catch(() => undefined);
      await cancellation.wait();
      await stop();
      origin = await start();
      assert.equal(origin, firstOrigin);
      assert.equal(worker.refreshes(), 1);
      const interrupted = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers,
        body: "{}",
      });
      const interruptedReader = interrupted.body.getReader();
      await interruptedReader.read();
      await Effect.runPromise(pool.refuse(true));
      await assert.rejects(interruptedReader.read(), /terminated|abort|socket|interrupted/u);
      const denied = await fetch(`${origin}/v1/models`, { headers });
      assert.equal(denied.status, 502);
      await denied.body.cancel();
      assert.equal(JSON.parse((await command(["status"])).stdout).state, "sign-in-required");
      await Effect.runPromise(pool.refuse(false));
      await command(["reconnect"]);
      await command(["revoke"]);
      assert.equal(JSON.parse((await command(["status"])).stdout).state, "revoked");
      await stop();
      const evidence = {
        realRouter: true,
        actualHostedNativeGrant: true,
        actualHostedMcpTool: true,
        nativeRenewals: worker.refreshes(),
        firstChunkBeforeCompletion: true,
        localProcessRestart: true,
        cancellationReachedExternalModel: true,
        revocationInterruptedStream: true,
        socketFinalOutputRetained: true,
        tunneledBackpressure: backpressure,
        syntheticModelAndPrivatePoolPeers: true,
        shortenedExternalLifetimeHint: true,
        credentialStorage: storage,
      };
      await writeFile(join(directory, "result.json"), JSON.stringify(evidence, null, 2), {
        mode: 0o600,
      });
      console.log(JSON.stringify(evidence));
    } finally {
      await stop();
      await fetch(`${worker.origin}/api/organizations/${actors.organization.id}/apps/${app.id}`, {
        method: "DELETE",
        headers: owner,
      });
    }
  });
});
try {
  await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
} catch (error) {
  await stop().catch(() => undefined);
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Native client product proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
