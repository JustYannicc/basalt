import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readBaseline, uploadVersion } from "./cloudflare.ts";
import { freezeUpload } from "./version-request.ts";
import { preparedUpload } from "./fixture.ts";
import * as HttpClientError from "effect/http/HttpClientError";

test("baseline reads the active deployment from a real SDK wire response", async () => {
  const sdk = HttpClient.make((request) =>
    Effect.succeed(
      HttpResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            deployments: [
              {
                id: "deployment",
                created_on: "2026-11-06T17:30:10.302879Z",
                source: "api",
                strategy: "percentage",
                author_email: "fixture@example.invalid",
                annotations: { "workers/triggered_by": "upload" },
                versions: [{ version_id: "active-version", percentage: 100 }],
              },
            ],
          },
        }),
      ),
    ),
  );
  const result = await Effect.runPromise(
    readBaseline({ accountId: "synthetic", scriptName: "Api" }).pipe(
      Effect.provideService(HttpClient.HttpClient, sdk),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic"),
          apiBaseUrl: "https://fixture.invalid",
        }),
      ),
    ),
  );
  assert.deepEqual(result, [{ versionId: "active-version", percentage: 100 }]);
});

test("version upload never retries a transient transport failure", async () => {
  let attempts = 0;
  const sdk = HttpClient.make((request) => {
    assert.equal(request.method, "POST");
    attempts++;
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request }),
      }),
    );
  });
  const worker = await freezeUpload(preparedUpload(), [{ versionId: "previous", percentage: 100 }]);
  await assert.rejects(
    Effect.runPromise(
      uploadVersion(worker).pipe(
        Effect.provideService(HttpClient.HttpClient, sdk),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic"),
            apiBaseUrl: "https://fixture.invalid",
          }),
        ),
      ),
    ),
  );
  assert.equal(attempts, 1);
});
