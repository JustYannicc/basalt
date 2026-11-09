import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Cause, Effect, Exit, Redacted } from "effect";
import { classProvisioning } from "./test/declared-class-fixture.ts";
import { reportRefusal } from "./refusal-report.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClassRequests } from "./class-refusals.ts";
import { preparedUpload } from "./fixture.ts";
import { BarrierRefusal } from "./manifest.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readDeclaredClass } from "./class-cloudflare.ts";
import { declaredChecks } from "./declared-checks.ts";
import { classCheckFailure } from "./class-refusal.ts";
import { withOperation } from "./operation-failure.ts";
import { releaseEvidence } from "./evidence.ts";

test("all independent concrete request refusals name their logical Worker before any live expansion", () => {
  const uploads = ["First", "Second"].map((fqn) => {
    const upload = preparedUpload(fqn);
    const next = {
      ...upload,
      request: {
        ...upload.request,
        metadata: {
          ...upload.request.metadata,
          migrations: { newSqliteClasses: ["Undeclared"] },
        },
      },
    };
    return [fqn, next] as const;
  });
  assert.throws(
    () => assertClassRequests({ captured: new Map(uploads) }, [], {}),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.deepEqual(
        error.refusals?.map((refusal) => ("fqn" in refusal ? refusal.fqn : null)),
        ["First", "Second"],
      );
      assert.ok(
        error.refusals?.every((refusal) => "changed" in refusal && refusal.changed.length > 0),
      );
      return true;
    },
  );
});

test("every independent live immutable Worker mismatch reaches the error and summary before mutation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "class-refusal-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const proof = classProvisioning({
    foreignLiveWorker: true,
    secondForeignWorker: true,
    expectedFailure: /native-target-drift/,
  });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, []);
  assert.equal(proof.cloneState().staged, 0);
  const failure = proof.failures[0];
  assert.ok(failure instanceof BarrierRefusal);
  assert.deepEqual(failure.refusals?.map((item) => ("fqn" in item ? item.fqn : null)).sort(), [
    "AppData",
    "OtherData",
  ]);
  const errors: string[] = [];
  const summary = join(root, "summary.md");
  await reportRefusal(failure, summary, (message) => {
    errors.push(message);
  });
  for (const output of [errors.join("\n"), await readFile(summary, "utf8")]) {
    assert.ok(output.includes("AppData"));
    assert.ok(output.includes("OtherData"));
    assert.ok(output.includes("workerIdentityHash"));
    assert.ok(!output.includes("replacement-worker"));
  }
});

test("post-deployment startup refusal reports its ceiling and observed duration in both outputs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "class-startup-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const proof = classProvisioning({
    startupTimeMs: 751,
    expectedFailure: /post-deployment-startup-refused/,
  });
  await Effect.runPromise(proof.effect);
  const failure = proof.failures[0];
  assert.ok(failure instanceof BarrierRefusal);
  const errors: string[] = [];
  const summary = join(root, "summary.md");
  await reportRefusal(failure, summary, (message) => {
    errors.push(message);
  });
  for (const output of [errors.join("\n"), await readFile(summary, "utf8")]) {
    assert.ok(output.includes("AppData"));
    assert.ok(output.includes("startupTimeMs"));
    assert.ok(output.includes("750"));
    assert.ok(output.includes("751"));
  }
});

test("request and live-baseline refusals are collected together before any mutation", async () => {
  const proof = classProvisioning({
    foreignLiveWorker: true,
    secondForeignWorker: true,
    deletedClass: true,
    expectedFailure: /migration-mismatch/,
  });
  await Effect.runPromise(proof.effect);
  const failure = proof.failures[0];
  assert.ok(failure instanceof BarrierRefusal);
  assert.deepEqual(
    new Set(failure.refusals?.map((item) => item.reason)),
    new Set(["declared-class-migration-mismatch", "declared-class-native-target-drift"]),
  );
  assert.deepEqual(
    new Set(failure.refusals?.map((item) => ("fqn" in item ? item.fqn : null))),
    new Set(["AppData", "OtherData"]),
  );
  assert.equal(proof.cloneState().staged, 0);
  assert.deepEqual(proof.events, []);
});

for (const reason of ["TransportError", "DecodeError"] as const)
  test(`declared class ${reason} reaches retained evidence and both public outputs safely`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "class-http-refusal-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "release-barrier");
    const secret = "synthetic-private-credential";
    let reads = 0;
    const client = HttpClient.make((request, url) => {
      assert.equal(request.method, "GET");
      reads++;
      if (url.pathname.endsWith("/deployments"))
        return Effect.succeed(
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
                    created_on: "2026-01-01T00:00:00Z",
                    source: "api",
                    strategy: "percentage",
                    versions: [{ version_id: "active", percentage: 100 }],
                  },
                ],
              },
            }),
          ),
        );
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
    const check = readDeclaredClass(
      { accountId: "synthetic-account", scriptName: "private-physical-name" },
      async () => {
        throw new Error("Unexpected settings read");
      },
    ).pipe(
      withOperation("AppData", "read-class-expansion"),
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
    const exit = await Effect.runPromiseExit(
      declaredChecks([{ fqn: "AppData", check }], classCheckFailure),
    );
    assert.ok(Exit.isFailure(exit));
    assert.equal(reads, 2);
    const failure = await releaseEvidence(directory, "a".repeat(40)).failure(
      Cause.squash(exit.cause),
    );
    const errors: string[] = [];
    const summary = join(root, "summary.md");
    await reportRefusal(failure, summary, (message) => errors.push(message));
    for (const output of [
      await readFile(join(directory, "failure.json"), "utf8"),
      await readFile(summary, "utf8"),
      errors.join("\n"),
    ]) {
      for (const expected of [
        "AppData",
        "read-class-expansion",
        "$provider.reason",
        "HttpClientError",
        reason,
      ])
        assert.ok(output.includes(expected), `missing ${expected}`);
      if (reason === "DecodeError") assert.ok(output.includes("503"));
      for (const privateValue of [secret, "private-provider.invalid", "private-physical-name"])
        assert.ok(!output.includes(privateValue));
    }
  });
