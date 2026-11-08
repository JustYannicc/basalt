import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readBaseline, uploadVersion } from "./cloudflare.ts";
import { freezeUpload } from "./version-request.ts";
import {
  assertRepairBaseline,
  assertRepairedPlacement,
  pendingPlacementRepair,
  placementRepairTargets,
} from "./pending-placement.ts";
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

test("the real version multipart repairs the exact damaged Api baseline and protects all setting groups", async () => {
  const input = preparedUpload();
  Object.assign(input.request.metadata, {
    limits: { subrequests: 50000 },
    placement: { region: "aws:eu-central-1" },
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    logpush: true,
    tailConsumers: [{ service: "fixture-tail" }],
    tags: ["fixture-tag"],
    bindings: [{ type: "durable_object_namespace", name: "Store", className: "Store" }],
  });
  const target = placementRepairTargets[0];
  input.request.scriptName = target.scriptName;
  const complete = {
    ...input,
    previousSettings: {
      limits: undefined,
      placement: undefined,
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
      logpush: true,
      tailConsumers: [{ service: "fixture-tail" }],
      tags: ["fixture-tag"],
      bindings: [{ type: "durable_object_namespace" as const, name: "Store", className: "Store" }],
    },
  };
  const baseline = [{ versionId: target.version, percentage: 100 }];
  const active = { id: target.version, placement: undefined };
  const prior = {
    id: target.prior,
    placement: {
      mode: "targeted",
      target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
    },
    limits: { subrequests: 50000 },
  };
  const repair = pendingPlacementRepair({
    role: target.role,
    scriptName: target.scriptName,
    deploymentId: target.deployment,
    baseline,
    active,
    prior,
    metadata: input.request.metadata,
    settings: complete.previousSettings,
    retired: false,
  });
  const worker = await freezeUpload(complete, baseline, [active], repair);
  assert.equal(worker.pendingPlacementRepair?.limits?.subrequests.after, 50000);
  let metadata: Record<string, unknown> | undefined;
  const sdk = HttpClient.make((request) =>
    Effect.promise(async () => {
      assert.equal(request.body._tag, "FormData");
      if (request.body._tag !== "FormData") throw new Error("Expected multipart upload");
      const part = request.body.formData.get("metadata");
      assert.ok(part !== null);
      metadata = JSON.parse(typeof part === "string" ? part : await part.text());
      return HttpResponse.fromWeb(
        request,
        Response.json({ success: true, result: { id: "new", startup_time_ms: 100 } }),
      );
    }),
  );
  await Effect.runPromise(
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
  );
  assertRepairBaseline(
    worker.id,
    worker.scriptName,
    complete.request.metadata,
    complete.previousSettings,
    repair,
    active,
  );
  for (const changed of [
    { tags: ["different"] },
    { logpush: false },
    { tailConsumers: [{ service: "different" }] },
    { limits: { subrequests: 10000 } },
  ])
    assert.throws(() =>
      assertRepairBaseline(
        worker.id,
        worker.scriptName,
        complete.request.metadata,
        { ...complete.previousSettings, ...changed },
        repair,
        active,
      ),
    );
  assertRepairedPlacement(
    worker.id,
    "new",
    { ...prior, id: "new" },
    {
      ...complete.previousSettings,
      placement: { mode: "targeted", target: [39] },
      limits: { subrequests: 50000 },
    },
    repair,
  );
  assert.deepEqual(metadata?.limits, { subrequests: 50000 });
  assert.deepEqual(metadata?.placement, { region: "aws:eu-central-1" });
  assert.deepEqual(metadata?.observability, {
    enabled: true,
    logs: { enabled: true, invocation_logs: true },
  });
  assert.deepEqual(metadata?.bindings, [
    { type: "durable_object_namespace", name: "Store", class_name: "Store" },
  ]);
  // These are script-scoped: the frozen baseline comparison, rather than an unsupported version field, protects them.
  for (const key of ["logpush", "tail_consumers", "tags", "streaming_tail_consumers"])
    assert.equal(metadata?.[key], undefined);
  for (const key of ["logpush", "tailConsumers", "tags"] as const) {
    const changed = preparedUpload();
    if (key === "logpush") changed.request.metadata.logpush = true;
    if (key === "tailConsumers")
      changed.request.metadata.tailConsumers = [{ service: "different" }];
    if (key === "tags") changed.request.metadata.tags = ["different"];
    await assert.rejects(freezeUpload(changed, worker.baseline));
  }
  const streaming = preparedUpload();
  streaming.request.metadata.streamingTailConsumers = [{ service: "unobservable" }];
  await assert.rejects(
    freezeUpload(streaming, worker.baseline),
    /unobservable-streaming-tail-settings/,
  );
  const classes = preparedUpload();
  classes.request.metadata.bindings = [
    { type: "durable_object_namespace", name: "Store", className: "New" },
  ];
  await assert.rejects(freezeUpload(classes, worker.baseline), /durable-object-class-drift/);
});
