import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import {
  runtimeNamespaceRequest,
  assertRuntimeNamespace,
  decodeNamespaceBaseline,
} from "./provisioning-namespace.ts";
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

test("green namespace provisioning retains an already provisioned blue namespace and both legacy module bytes", () => {
  const baseline = namespaceBaseline();
  const blue = runtimeNamespaceRequest(
    baseline,
    runtimeDeclaration("PoolRuntimeBlue"),
    "blue-operation",
  );
  const { accountId: _account, workerId: _worker, deploy: _deploy, ...blueSettings } = blue;
  const next = decodeNamespaceBaseline({
    ...baseline,
    version: {
      ...baseline.version,
      ...blueSettings,
      id: "blue-version",
      bindings: [
        ...baseline.version.bindings!,
        {
          name: "PoolRuntimeBlue",
          type: "durable_object_namespace" as const,
          className: "PoolRuntimeBlue",
          namespaceId: "blue-namespace",
        },
      ],
    },
    containers: blue.containers!,
    namespaces: [
      ...baseline.namespaces,
      {
        id: "blue-namespace",
        className: "PoolRuntimeBlue",
        binding: "PoolRuntimeBlue",
        storage: "sqlite" as const,
      },
    ],
  });
  const green = runtimeNamespaceRequest(
    next,
    runtimeDeclaration("PoolRuntimeGreen"),
    "green-operation",
  );
  assert.deepEqual(green.exports, {
    ...blue.exports,
    PoolRuntimeGreen: {
      type: "durable-object",
      storage: "sqlite",
      container: "PoolRuntimeGreen",
      state: "created",
    },
  });
  assert.deepEqual(green.modules!.slice(1, -1), blue.modules!.slice(1));
  const observation = {
    accountId: baseline.accountId,
    scriptName: baseline.scriptName,
    versionId: "green-version",
    deploymentId: "green-deployment",
    exports: readRuntimeExports(green.exports),
    containers: green.containers!,
    namespaces: [
      ...next.namespaces,
      {
        id: "green-namespace",
        className: "PoolRuntimeGreen",
        binding: "PoolRuntimeGreen",
        storage: "sqlite" as const,
      },
    ],
  };
  assert.equal(
    assertRuntimeNamespace(next, green, "green-version", observation).namespaceId,
    "green-namespace",
  );
  assert.throws(
    () => runtimeNamespaceRequest(next, runtimeDeclaration("PoolRuntimeBlue"), "repeat"),
    /provisioning-namespace-baseline-unsupported/,
  );
  assert.throws(
    () =>
      assertRuntimeNamespace(next, green, "green-version", {
        ...observation,
        namespaces: observation.namespaces.map((row) =>
          row.className === "PoolRuntimeBlue" ? { ...row, id: "crossed" } : row,
        ),
      }),
    /provisioning-input-drift/,
  );
});

test("a current Worker bundle with unbound runtime exports provisions metadata without replacing code or adding duplicate exports", () => {
  for (const code of [
    "export class PoolContainer {}\nexport class PoolRuntimeBlue {}\nexport class PoolRuntimeGreen {}\nexport default {};\n",
    "class A{}; class B{}; class C{}; export { A as PoolContainer, B as PoolRuntimeBlue, C as PoolRuntimeGreen }; export default {};\n",
  ]) {
    const baseline = namespaceBaseline();
    const main = baseline.version.modules![0]!;
    main.contentBase64 = Buffer.from(code).toString("base64");
    for (const name of ["PoolRuntimeBlue", "PoolRuntimeGreen"] as const) {
      const request = runtimeNamespaceRequest(
        baseline,
        runtimeDeclaration(name),
        `existing-${name}`,
      );
      assert.deepEqual(request.modules, baseline.version.modules);
      assert.equal(request.modules!.length, 2);
      assert.deepEqual(readRuntimeExports(request.exports)[name], {
        type: "durable-object",
        storage: "sqlite",
        container: name,
        state: "created",
      });
    }
  }
});

test("an ambiguous or malformed bundle cannot silently replace a runtime export", () => {
  for (const code of [
    "export * from './opaque.mjs'; export default {};",
    "export class PoolRuntimeBlue {",
  ]) {
    const baseline = namespaceBaseline();
    baseline.version.modules![0]!.contentBase64 = Buffer.from(code).toString("base64");
    assert.throws(
      () =>
        runtimeNamespaceRequest(
          baseline,
          runtimeDeclaration("PoolRuntimeBlue"),
          "unconfirmed-export",
        ),
      /provisioning-namespace-module-unsupported/,
    );
  }
});
