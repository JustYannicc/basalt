import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { ConfigProvider, Effect, Exit, Cause } from "effect";
import { FetchHttpClient } from "effect/http";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import type * as HttpClient from "effect/http/HttpClient";
import { readDeclaredClass } from "./class-cloudflare.ts";
import { withOperation } from "./operation-failure.ts";
import { classCheckFailure } from "./class-refusal.ts";
import { BarrierRefusal } from "./manifest.ts";

const target = { accountId: "fixture-account", scriptName: "fixture-worker" };
const settings = {
  compatibilityDate: "2026-09-08",
  compatibilityFlags: [],
  bindings: [],
  tags: ["alchemy:migration-tag:1"],
};

// The class path receives whatever its caller holds: the captured alchemy upload request at
// preparation, and the frozen observation at completion and readiness.
const callerTargets = {
  "captured upload request": {
    ...target,
    metadata: {
      mainModule: "worker.js",
      compatibilityDate: "2026-09-08",
      bindings: [{ type: "durable_object_namespace", name: "DRIVE", className: "DriveObject" }],
      tags: ["alchemy:migration-tag:1"],
    },
    files: [
      new File(["export default {}"], "worker.js", { type: "application/javascript+module" }),
    ],
  } satisfies Workers.PutScriptRequest,
  "frozen class observation": {
    ...target,
    workerId: "immutable-worker",
    versionId: "active",
    migrationTag: "1",
    settings,
    previewUrlsEnabled: false,
    containers: [{ className: "PoolContainer" }],
  },
};

const result = (path: string) =>
  path.endsWith("/deployments")
    ? {
        deployments: [
          {
            id: "deployment",
            created_on: "2026-11-07T00:00:00Z",
            strategy: "percentage",
            versions: [{ version_id: "active", percentage: 100 }],
          },
        ],
      }
    : path.endsWith("/settings")
      ? { bindings: [], tags: settings.tags }
      : path.endsWith("/workers/workers/fixture-worker/versions/active")
        ? {
            id: "active",
            number: 3,
            created_on: "2026-11-07T00:00:00Z",
            urls: [],
            containers: [{ class_name: "PoolContainer" }],
          }
        : path.endsWith("/workers/workers/fixture-worker")
          ? {
              id: "immutable-worker",
              name: "fixture-worker",
              created_on: "2026-11-07T00:00:00Z",
              updated_on: "2026-11-07T00:00:00Z",
              logpush: false,
              observability: {},
              references: [],
              subdomain: { enabled: false, previews_enabled: false },
              tags: [],
              tail_consumers: [],
            }
          : path.endsWith("/scripts/fixture-worker/versions/active")
            ? { id: "active", resources: { bindings: [], script_runtime: { migration_tag: "1" } } }
            : undefined;

async function stub(context: TestContext) {
  const requests: { method?: string; path?: string; bytes: number }[] = [];
  const server = createServer(async (request, response) => {
    let bytes = 0;
    for await (const chunk of request) bytes += chunk.length;
    requests.push({ method: request.method, path: request.url, bytes });
    const value = result(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.statusCode = value ? 200 : 404;
    response.end(JSON.stringify({ success: !!value, errors: [], messages: [], result: value }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, requests };
}

// The deploy context: alchemy's FetchHttpClient.layer over Node's global fetch, mapped to a
// refusal exactly as class preparation does.
const deployRead = <A, E>(
  base: string,
  effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  Effect.runPromiseExit(
    Effect.tryPromise({
      try: () =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(
              Credentials,
              Effect.succeed(apiTokenCredentials({ apiToken: "synthetic", apiBaseUrl: base })),
            ),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic" } }),
              ),
            ),
          ),
        ),
      catch: (error) => error,
    }).pipe(withOperation("PoolWorker", "read-class-expansion")),
  );

for (const [shape, callerTarget] of Object.entries(callerTargets))
  test(`the deploy class read sends only bodiless GETs through real fetch (${shape})`, async (context) => {
    const { base, requests } = await stub(context);
    // Settings use their own bounded fetch against the fixed API origin; keep it on the stub.
    const settingsFetch: typeof fetch = (input, init) =>
      fetch(String(input).replace("https://api.cloudflare.com/client/v4", base), init);
    const exit = await deployRead(base, readDeclaredClass(callerTarget, settingsFetch));
    if (Exit.isFailure(exit)) {
      const refusal = classCheckFailure(Cause.squash(exit.cause), "PoolWorker");
      assert.ok(refusal instanceof BarrierRefusal);
      assert.fail(`${refusal.reason}: ${JSON.stringify(refusal.delta?.changed)}`);
    }
    assert.equal(exit.value.workerId, "immutable-worker");
    assert.equal(exit.value.versionId, "active");
    assert.equal(exit.value.migrationTag, "1");
    assert.deepEqual(exit.value.containers, [{ className: "PoolContainer" }]);
    const scripts = "/accounts/fixture-account/workers/scripts/fixture-worker";
    const workers = "/accounts/fixture-account/workers/workers/fixture-worker";
    assert.deepEqual(
      new Set(requests.map((request) => request.path)),
      new Set([
        `${scripts}/deployments`,
        `${scripts}/versions/active`,
        `${scripts}/settings`,
        `${workers}/versions/active`,
        workers,
      ]),
    );
    for (const request of requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.bytes, 0);
    }
  });

test("an SDK GET given an unmodelled key refuses with fetch's own message", async (context) => {
  const { base, requests } = await stub(context);
  const exit = await deployRead(
    base,
    // Retry.none as in readDeclaredClass; the SDK default would retry the TransportError.
    Workers.getScriptVersion({
      ...target,
      versionId: "active",
      extra: 1,
    } as Workers.GetScriptVersionRequest).pipe(Retry.none),
  );
  assert.ok(Exit.isFailure(exit));
  const rows = classCheckFailure(Cause.squash(exit.cause), "PoolWorker").delta?.changed ?? [];
  const value = (path: string) => rows.find((row) => row.path === path && "new" in row);
  assert.deepEqual(value("$provider.reason"), {
    path: "$provider.reason",
    old: null,
    new: "TransportError",
  });
  assert.deepEqual(value("$provider.request.method"), {
    path: "$provider.request.method",
    old: null,
    new: "GET",
  });
  const message = value("$provider.cause.0.message");
  assert.ok(message && "new" in message);
  assert.match(String(message.new), /Request with GET\/HEAD method cannot have body\./u);
  // Fetch refuses before anything leaves the process.
  assert.equal(requests.length, 0);
});
