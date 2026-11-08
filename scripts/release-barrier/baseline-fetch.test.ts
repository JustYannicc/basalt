import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Cause, Effect, Exit, Fiber, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readBaseline } from "./cloudflare.ts";
import { preparedUpload } from "./fixture.ts";
import { freezeUpload } from "./version-request.ts";

for (const phase of ["prepared", "frozen"] as const)
  test(`native fetch reads the ${phase} Worker baseline without an upload body`, async (context) => {
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
                created_on: "2026-11-01T00:00:00Z",
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
    context.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const upload = preparedUpload("PublicSite");
    const frozen = await freezeUpload(upload, [{ versionId: "previous", percentage: 100 }]);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const input = phase === "prepared" ? upload.request : frozen;
        const fiber = yield* readBaseline(input).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 minutes");
        assert.deepEqual(yield* Fiber.join(fiber), [{ versionId: "previous", percentage: 100 }]);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic"),
            apiBaseUrl: `http://127.0.0.1:${address.port}`,
          }),
        ),
        Effect.provide(TestClock.layer()),
      ),
    );
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    const transport = error instanceof Error && "reason" in error ? error.reason : undefined;
    const native =
      typeof transport === "object" && transport !== null && "cause" in transport
        ? transport.cause
        : undefined;
    assert.ok(
      Exit.isSuccess(exit),
      `${error}; native cause: ${String(native)}; received: ${requests.length}`,
    );
    assert.deepEqual(requests, [
      {
        method: "GET",
        path: "/accounts/fixture/workers/scripts/PublicSite/deployments",
        bytes: 0,
      },
    ]);
  });
