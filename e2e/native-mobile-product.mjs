import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { verifyNativeMobile } from "./native-mobile.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const upstream = join(root, ".upstream");
await mkdir(join(root, ".generated"), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, ".generated/native-mobile-"));
process.chdir(upstream);
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
  // A separate environment keeps the desktop load test's auth budget out of this scenario.
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const prepared = yield* prepareScenario(
    base.target,
    "Phone controller through real hosted grants",
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
      organization: "native-mobile",
      namePrefix: "native-mobile",
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
          name: "Phone controller proof",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, mutation, object, query, router } from "apps"; export default defineApp({}, { tools: router({ echo: query({ input: object({}) }, async () => ({ receipt: ${JSON.stringify(receipt)} })), confirm: mutation({ input: object({}), approval: () => "user-approval" }, async () => ({ receipt: ${JSON.stringify(receipt)} })) }) });`,
            },
            appsManifest,
          ],
        }),
      },
    );
    assert.equal(deployed.status, 200);
    const app = await deployed.json();
    try {
      const mobile = await verifyNativeMobile({ origin: worker.origin, owner, app, receipt });
      assert.equal(worker.refreshes(), 1, "The phone renews the shortened real hosted grant once.");
      const result = {
        mobile,
        realRouter: true,
        actualHostedNativeGrant: true,
        actualHostedMcpTool: true,
        nativeRenewals: worker.refreshes(),
        syntheticModelAndPrivatePoolPeers: true,
        shortenedExternalLifetimeHint: true,
        authRateLimitEnabled: true,
      };
      await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), {
        mode: 0o600,
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      await writeFile(join(directory, "failure-first.txt"), String(error?.stack ?? error), {
        mode: 0o600,
      });
      throw error;
    } finally {
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
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Phone controller product proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
