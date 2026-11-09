import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/http";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { readVersionPlacement } from "./active-placement-read.ts";
import { safeProviderFailure } from "./operation-failure.ts";

for (const status of [429, 503, 403])
  test(`native immutable-version read handles HTTP ${status}`, async (context) => {
    let attempts = 0;
    const server = createServer(async (request, response) => {
      let bytes = 0;
      for await (const chunk of request) bytes += chunk.length;
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/accounts/fixture/workers/scripts/worker/versions/active");
      assert.equal(bytes, 0);
      attempts++;
      response.setHeader("content-type", "application/json");
      if (attempts === 1 || status === 403) {
        response.statusCode = status;
        response.setHeader("retry-after", "1");
        response.end(JSON.stringify({ success: false, errors: [{ message: "private-fixture" }] }));
      } else
        response.end(
          JSON.stringify({
            success: true,
            result: {
              id: "active",
              resources: {
                bindings: [
                  { name: "POOL_IMAGE_HASH", type: "plain_text", text: "a".repeat(16) },
                  { name: "PRIVATE_FIXTURE", type: "secret_text", text: "private-fixture" },
                ],
                script_runtime: { limits: { subrequests: 50000 } },
                script: {
                  placement: {
                    mode: "targeted",
                    target: [{ id: 39, type: "region", region: "aws:eu-central-1" }],
                  },
                },
              },
            },
          }),
        );
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
    const result = await Effect.runPromiseExit(
      readVersionPlacement("fixture", "worker", "active").pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(
          Credentials,
          Effect.succeed(
            apiTokenCredentials({
              apiToken: "synthetic",
              apiBaseUrl: `http://127.0.0.1:${address.port}`,
            }),
          ),
        ),
      ),
    );
    if (status === 403) {
      assert.ok(Exit.isFailure(result));
      const safe = safeProviderFailure(Cause.squash(result.cause));
      assert.deepEqual(safe, { type: "Forbidden", status: 403 });
    } else {
      assert.ok(Exit.isSuccess(result));
      assert.equal(attempts, 2);
      assert.equal(result.value.id, "active");
      assert.deepEqual(result.value.bindings, [
        { name: "POOL_IMAGE_HASH", type: "plain_text", text: "a".repeat(16) },
      ]);
      assert.doesNotMatch(JSON.stringify(result.value), /private-fixture/);
      assert.deepEqual(result.value.limits, { subrequests: 50000 });
    }
  });
