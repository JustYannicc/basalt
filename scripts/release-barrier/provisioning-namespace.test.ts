import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { runtimeNamespaceRequest, assertRuntimeNamespace } from "./provisioning-namespace.ts";
import { readRuntimeExports } from "./provisioning-exports.ts";

import { runtimeDeclaration, namespaceBaseline } from "./test/provisioning-fixtures.ts";

test("namespace expansion preserves exports, container metadata, inherited binding version and other module bytes", () => {
  const baseline = namespaceBaseline();
  const request = runtimeNamespaceRequest(baseline, runtimeDeclaration(), "synthetic-operation");
  assert.deepEqual(request.exports, {
    ...baseline.version.exports,
    PoolRuntime: {
      type: "durable-object",
      storage: "sqlite",
      container: "PoolRuntime",
      state: "created",
    },
  });
  assert.deepEqual(request.containers, [
    { className: "PoolContainer" },
    { className: "PoolRuntime" },
  ]);
  assert.deepEqual(request.modules?.[1], baseline.version.modules?.[1]);
  assert.equal(
    Buffer.from(request.modules![0]!.contentBase64, "base64")
      .toString()
      .startsWith(Buffer.from(baseline.version.modules![0]!.contentBase64, "base64").toString()),
    true,
  );
  assert.deepEqual(request.bindings?.[1], {
    type: "inherit",
    name: "KEEP",
    versionId: "baseline-version",
  });
  assert.equal(request.deploy, false);
  assert.deepEqual(request.cacheOptions, baseline.version.cacheOptions);
});

test("the real SDK sends declarative exports and explicit container enablement on the version API", async () => {
  const request = runtimeNamespaceRequest(
    namespaceBaseline(),
    runtimeDeclaration(),
    "synthetic-operation",
  );
  let sent = 0;
  const client = HttpClient.make((req, url) =>
    Effect.sync(() => {
      assert.equal(req.method, "POST");
      assert.equal(
        url.toString(),
        `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/workers/synthetic-worker/versions?deploy=false`,
      );
      assert.equal(req.body._tag, "Uint8Array");
      if (req.body._tag !== "Uint8Array") throw new Error("Expected encoded SDK body");
      const body = JSON.parse(new TextDecoder().decode(req.body.body));
      assert.deepEqual(body.exports, {
        default: { type: "worker", cache_options: { enabled: true } },
        PoolContainer: {
          type: "durable-object",
          storage: "sqlite",
          container: "PoolContainer",
          state: "created",
        },
        PoolRuntime: {
          type: "durable-object",
          storage: "sqlite",
          container: "PoolRuntime",
          state: "created",
        },
      });
      assert.deepEqual(body.containers, [
        { class_name: "PoolContainer" },
        { class_name: "PoolRuntime" },
      ]);
      assert.deepEqual(body.bindings[1], {
        type: "inherit",
        name: "KEEP",
        version_id: "baseline-version",
      });
      assert.equal(body.deploy, undefined);
      assert.equal(body.migrations, undefined);
      sent++;
      return HttpResponse.fromWeb(
        req,
        Response.json({
          success: true,
          result: { id: "staged-version", created_on: "2026-11-09T00:00:00Z", number: 2, urls: [] },
        }),
      );
    }),
  );
  const result = await Effect.runPromise(
    Workers.createBetaWorkerVersion(request).pipe(
      Retry.none,
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic-only"),
          apiBaseUrl: "https://api.cloudflare.com/client/v4",
        }),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    ),
  );
  assert.equal(result.id, "staged-version");
  assert.equal(sent, 1);
});

test("namespace readback requires legacy IDs unchanged and one new exact SQLite namespace", () => {
  const baseline = namespaceBaseline();
  const request = runtimeNamespaceRequest(baseline, runtimeDeclaration(), "synthetic-operation");
  const observed = {
    accountId: baseline.accountId,
    scriptName: baseline.scriptName,
    versionId: "staged-version",
    deploymentId: "deployment",
    exports: readRuntimeExports(request.exports),
    containers: request.containers!,
    namespaces: [
      ...baseline.namespaces,
      {
        id: "new-namespace",
        className: "PoolRuntime",
        binding: "PoolRuntime",
        storage: "sqlite" as const,
      },
    ],
  };
  assert.equal(
    assertRuntimeNamespace(baseline, request, "staged-version", observed).namespaceId,
    "new-namespace",
  );
  assert.throws(
    () =>
      assertRuntimeNamespace(baseline, request, "staged-version", {
        ...observed,
        namespaces: [{ ...baseline.namespaces[0]!, id: "changed-legacy" }, observed.namespaces[1]!],
      }),
    /provisioning-input-drift/,
  );
  assert.throws(
    () =>
      assertRuntimeNamespace(baseline, request, "staged-version", {
        ...observed,
        namespaces: baseline.namespaces,
      }),
    /provisioning-namespace-unconfirmed/,
  );
});
