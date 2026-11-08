import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readDeclaredBucket } from "./bucket-cloudflare.ts";
import { bucketRead } from "./bucket-failure.ts";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";

for (const reason of ["TransportError", "DecodeError"] as const)
  test(`declared bucket ${reason} reaches retained evidence and both public outputs safely`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "bucket-http-refusal-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "release-barrier");
    const secret = "synthetic-private-credential";
    let reads = 0;
    const client = HttpClient.make((request) => {
      assert.equal(request.method, "GET");
      reads++;
      const cause = new Error(secret);
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason:
            reason === "TransportError"
              ? new HttpClientError.TransportError({ request, cause })
              : new HttpClientError.DecodeError({
                  request,
                  cause,
                  response: HttpResponse.fromWeb(request, new Response(secret, { status: 503 })),
                }),
        }),
      );
    });
    const observation = readDeclaredBucket({
      accountId: "synthetic-account",
      bucketName: "private-physical-name",
      jurisdiction: "eu",
      storageClass: "Standard",
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make(secret),
          apiBaseUrl: "https://private-provider.invalid",
        }),
      ),
    );
    let caught: unknown;
    try {
      await bucketRead("DriveRecords", () => Effect.runPromise(observation));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    assert.equal(reads, 1);
    const failure = await releaseEvidence(directory, "a".repeat(40)).failure(caught);
    const errors: string[] = [];
    const summary = join(root, "summary.md");
    await reportRefusal(failure, summary, (message) => errors.push(message));
    for (const output of [
      await readFile(join(directory, "failure.json"), "utf8"),
      await readFile(summary, "utf8"),
      errors.join("\n"),
    ]) {
      for (const expected of ["DriveRecords", "$provider.reason", "HttpClientError", reason])
        assert.ok(output.includes(expected), `missing ${expected}`);
      if (reason === "DecodeError") assert.ok(output.includes("503"));
      for (const privateValue of [secret, "private-provider.invalid", "private-physical-name"])
        assert.ok(!output.includes(privateValue));
    }
  });
