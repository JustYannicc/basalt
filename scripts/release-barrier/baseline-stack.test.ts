import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readBaseline } from "./cloudflare.ts";
import { fixture } from "./test/deploy-stack-fixture.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import { releaseEvidence } from "./evidence.ts";
import { refusalTable } from "./refusal-report.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workerIds = [
  "Api",
  "AppCompiler",
  "AppData",
  "AppDomainController",
  "AppPages",
  "ArtifactsCredentials",
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

const sdkFixture = (failure: "once" | "transport" | "forbidden", failedWorker = "Api") => {
  const reads = new Map<string, number>();
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      assert.equal(request.method, "GET");
      assert.ok(url.pathname.endsWith("/deployments"));
      const worker = url.pathname.split("/").at(-2)!;
      const count = (reads.get(worker) ?? 0) + 1;
      reads.set(worker, count);
      if (
        (failure === "transport" && worker === failedWorker) ||
        (failure === "once" && count === 1)
      )
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("synthetic-private-token"),
            }),
          }),
        );
      const response =
        failure === "forbidden" && worker === failedWorker
          ? Response.json(
              { success: false, errors: [{ code: 10099, message: "synthetic-private-token" }] },
              { status: 403 },
            )
          : Response.json({
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
            });
      return Effect.succeed(HttpResponse.fromWeb(request, response));
    }),
  );
  const proof = fixture({
    extraWorkers: workerIds.filter((id) => !["Api", "Router"].includes(id)),
    baseline: (worker) =>
      Effect.gen(function* () {
        const fiber = yield* readBaseline(worker).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(
            Credentials,
            Effect.succeed({
              type: "apiToken",
              apiToken: Redacted.make("synthetic-private-token"),
              apiBaseUrl: "https://fixture.invalid",
            }),
          ),
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 minutes");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
  });
  const run = () => Effect.runPromiseExit(proof.effect);
  return { ...proof, reads, run };
};

test("every captured Worker baseline retries its first transient GET and releases exact versions", async () => {
  const proof = sdkFixture("once");
  const exit = await proof.run();
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "");
  assert.deepEqual(
    [...proof.reads].sort(),
    workerIds.map((id) => [id, 3]),
  );
  assert.equal(proof.receipts.at(-1)?.phase, "complete");
  assert.deepEqual(
    proof.receipts.at(-1)?.activated,
    workerIds.map((worker) => ({ worker, versionId: `accepted-${worker}` })),
  );
});

for (const scenario of ["transport", "forbidden"] as const)
  for (const failedWorker of ["Api", "Router"])
    test(`permanent ${scenario} ${failedWorker} baseline failure remains bounded and safely typed`, async (context) => {
      const directory = await mkdtemp(join(tmpdir(), "baseline-failure-"));
      context.after(() => rm(directory, { recursive: true, force: true }));
      const proof = sdkFixture(scenario, failedWorker);
      const exit = await proof.run();
      assert.ok(Exit.isFailure(exit));
      assert.deepEqual(
        [...proof.reads].sort(),
        workerIds.map((worker) => [
          worker,
          scenario === "transport" && worker === failedWorker ? 9 : 1,
        ]),
      );
      const failure = await releaseEvidence(directory, "a".repeat(40)).failure(
        Cause.squash(exit.cause),
      );
      assert.equal(failure.operation, "read-worker-baseline");
      assert.equal(failure.worker, failedWorker);
      assert.deepEqual(
        failure.provider,
        scenario === "transport"
          ? { type: "HttpClientError", reason: "TransportError" }
          : { type: "Forbidden" },
      );
      assert.equal(failure.manifest, null);
      assert.deepEqual(failure.activated, []);
      assert.deepEqual(proof.events, []);
      assert.equal(proof.writes(), 0);
      for (const output of [
        await readFile(join(directory, "failure.json"), "utf8"),
        refusalTable(failure),
      ]) {
        assert.ok(output.includes(failure.provider!.type));
        if (scenario === "transport") assert.ok(output.includes("TransportError"));
        assert.ok(!output.includes("synthetic-private-token"));
        assert.ok(!output.includes("fixture.invalid"));
      }
    });

test("HttpClientError exposes only its closed reason and numeric response status", () => {
  const request = { url: "https://private.invalid?token=secret" };
  assert.deepEqual(
    safeProviderFailure({
      _tag: "HttpClientError",
      reason: { _tag: "StatusCodeError", request, response: { status: 503, body: "secret" } },
    }),
    { type: "HttpClientError", reason: "StatusCodeError", status: 503 },
  );
});
