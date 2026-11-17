// Regression: read-worker-baseline-api
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Cause, Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readBaseline } from "./cloudflare.ts";
import { fixture } from "./test/deploy-stack-fixture.ts";

const workerIds = [
  "Api",
  "AppCompiler",
  "AppData",
  "AppDomainController",
  "AppOutbound",
  "AppPages",
  "Authoring",
  "Catalog",
  "Dashboard",
  "Edge",
  "Formatter",
  "InvocationTelemetry",
  "Marketing",
  "McpServer",
  "OAuthWire",
  "PoolWorker",
  "PublicSite",
  "Router",
  "Sso",
].sort();

// The release refused at Api's baseline read while every fake HttpClient passed: the barrier hands
// the whole upload request to the read, and only native fetch refuses a GET that carries it as a body.
test("the barrier reads every Worker baseline, Api first, over native fetch without a request body", async (context) => {
  const requests: { method: string | undefined; path: string | undefined; bytes: number }[] = [];
  const server = createServer(async (request, response) => {
    let bytes = 0;
    for await (const chunk of request) bytes += chunk.length;
    requests.push({ method: request.method, path: request.url, bytes });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: {
          deployments: [
            {
              id: "deployment",
              created_on: "2026-01-01T00:00:00Z",
              source: "api",
              strategy: "percentage",
              versions: [{ version_id: "previous", percentage: 100 }],
            },
          ],
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const proof = fixture({
    extraWorkers: workerIds.filter((id) => !["Api", "Router"].includes(id)),
    baseline: (worker) =>
      readBaseline(worker).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic"),
            apiBaseUrl: `http://127.0.0.1:${address.port}`,
          }),
        ),
      ),
  });
  const exit = await Effect.runPromiseExit(proof.effect);
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
  const refusal = error as { operation?: string; worker?: string; provider?: unknown } | undefined;
  assert.ok(
    Exit.isSuccess(exit),
    `${String(error)}; operation ${refusal?.operation}; worker ${refusal?.worker}; provider ${JSON.stringify(refusal?.provider)}; requests received ${requests.length}`,
  );
  assert.deepEqual(
    [...new Set(requests.map((request) => request.path))].sort(),
    workerIds.map((id) => `/accounts/fixture/workers/scripts/${id}/deployments`).sort(),
  );
  for (const request of requests) assert.deepEqual([request.method, request.bytes], ["GET", 0]);
  assert.equal(proof.receipts.at(-1)?.phase, "complete");
  assert.deepEqual(
    proof.receipts.at(-1)?.activated,
    workerIds.map((worker) => ({ worker, versionId: `accepted-${worker}` })),
  );
});
