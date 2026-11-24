import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { runtimeHandoffCommandPrefix, runtimeHandoffPath } from "./runtime-slots/handoff-command.ts";
import { signEnvelope } from "./token.ts";
import { poolWorkerCompatibility } from "./worker-compatibility.ts";

// The fleet lane and the release send signed commands to PoolOperations, which hands the request to
// the controller over RPC. RPC refuses to clone an AbortSignal, and a request given one of its own
// so it never follows its caller failed every /runtime-handoff with DataCloneError on 24 Nov. This
// runs the real PoolOperations and controller with the pool Worker's own flags; only the container
// is a fixture.
const fixture = `
import { DurableObject } from "cloudflare:workers";
import { PoolContainer, PoolOperations } from "./src/pool/worker.ts";
export class Controller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const container = { running: false, start() { this.running = true; }, async destroy() { this.running = false; },
      async setInactivityTimeout() {}, getTcpPort() { return { fetch: async () => new Response(null, { status: 503 }) }; } };
    Object.defineProperty(ctx, "container", { value: container });
    this.pool = new PoolContainer(ctx, env);
  }
  runtimeHandoff(request) { return this.pool.runtimeHandoff(request); }
}
export class Operations extends PoolOperations {
  constructor(ctx, env) {
    super(ctx, { ...env, PoolContainer: { jurisdiction: () => env.CONTROLLER } });
  }
}
// The entrypoint's own request is the incoming one: with \`enable_request_signal\` its signal is live
// and fires when the operations client leaves. A service binding never forwards a caller's signal.
export default { fetch: (request, env) => env.OPERATIONS.fetch(request) };
`;

async function pool() {
  const bundle = await build({
    stdin: {
      contents: fixture,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "module", "import"],
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
    plugins: [
      {
        name: "unavailable-account-database",
        setup(build) {
          build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "unavailable" }));
          build.onLoad({ filter: /.*/, namespace: "unavailable" }, () => ({
            contents:
              "export default {Pool: class {constructor(){throw Error('An inspect must not query the account database');}}};",
          }));
        },
      },
    ],
  });
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "pool",
          modules: true,
          script: bundle.outputFiles[0]!.text,
          compatibilityDate: poolWorkerCompatibility.date,
          compatibilityFlags: poolWorkerCompatibility.flags,
          bindings: {
            POOL_DEPLOYMENT_KEY: deploymentKey,
            POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
            POOL_MANAGEMENT_KEY: "fixture-management",
            POOL_APP_SIGNING_KEY: "ab".repeat(32),
            POOL_IMAGE_HASH: "fixture",
          },
          durableObjects: { CONTROLLER: { className: "Controller", useSQLite: true } },
          serviceBindings: { OPERATIONS: { name: "pool", entrypoint: "Operations" } },
          outboundService: () => new Response(null, { status: 403 }),
        },
      ],
    }),
  );
}

const deploymentKey = "cd".repeat(32);

async function inspect() {
  const mf = await pool();
  try {
    const at = Date.now();
    const envelope = await signEnvelope(deploymentKey, runtimeHandoffCommandPrefix, {
      action: "inspect",
      controllerCode: { candidate: productionOpsRelease, workerInput: poolWorkerRevision },
      at,
      expiresAt: at + 30_000,
    });
    const response: Response = await mf.dispatchFetch(`http://pool-operations${runtimeHandoffPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
      headers: { "content-type": "application/json" },
    });
    return { status: response.status, body: await response.text() };
  } finally {
    await mf.dispose();
  }
}

test(
  "a signed inspect reaches the controller through PoolOperations",
  { timeout: 60_000 },
  async () => {
    const { status, body } = await inspect();
    assert.equal(status, 200, body);
    // The controller's own inspect: it names the code it runs and its recovery state.
    const { result } = JSON.parse(body);
    assert.deepEqual(result.controllerCode, {
      candidate: productionOpsRelease,
      workerInput: poolWorkerRevision,
    });
    assert.ok(result.recovery, body);
  },
);
