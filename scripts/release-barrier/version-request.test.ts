import assert from "node:assert/strict";
import { test } from "node:test";
import { freezeUpload, uploadRequest, versionMetadata } from "./version-request.ts";
import { manifestDigest } from "./manifest.ts";

import { preparedUpload } from "./fixture.ts";

test("freezes the root provider bytes, flags, bindings and complete asset policy without a rebuild", async () => {
  const input = preparedUpload();
  input.request.metadata.keepAssets = true;
  input.request.metadata.containers = [{ className: "PoolContainer" }];
  input.request.metadata.assets = {
    config: {
      headers: "/asset/*\n X-Fixture: one",
      redirects: "/old /new 301",
      runWorkerFirst: ["/api/*"],
      serveDirectly: true,
    },
  };
  const worker = await freezeUpload(input, [{ versionId: "old", percentage: 100 }]);
  const request = uploadRequest(worker);
  assert.deepEqual(request.metadata.assets, input.request.metadata.assets);
  assert.equal(request.metadata.keepAssets, true);
  assert.deepEqual(request.metadata.containers, [{ className: "PoolContainer" }]);
  assert.equal(request.bindingsInherit, "strict");
  assert.deepEqual(request.metadata.compatibilityFlags, input.request.metadata.compatibilityFlags);
  assert.deepEqual(request.metadata.bindings, input.request.metadata.bindings);
  assert.equal(request.metadata.migrations, undefined);
  const frozenHash = manifestDigest({
    candidate: "a".repeat(40),
    stack: "basalt",
    stage: "production",
    workers: [worker],
  });
  input.request.metadata.bindings = [];
  input.request.metadata.assets.config!.headers = "changed";
  assert.equal(
    manifestDigest({
      candidate: "a".repeat(40),
      stack: "basalt",
      stage: "production",
      workers: [worker],
    }),
    frozenHash,
  );
  const files = request.files;
  assert.ok(Array.isArray(files));
  assert.equal(await files[0]!.text(), "export default {}");
});

test("refuses actual DO changes, local class drift, changed global settings and per-attempt bindings", () => {
  const migration = preparedUpload();
  migration.request.metadata.migrations = { newSqliteClasses: ["NewClass"] };
  assert.throws(() => versionMetadata(migration), /durable-object-migration/);
  const renamed = preparedUpload();
  renamed.request.metadata.bindings = [
    { type: "durable_object_namespace", name: "Store", className: "Changed" },
  ];
  assert.throws(() => versionMetadata(renamed), /durable-object-class-drift/);
  const settings = preparedUpload();
  const changed = { ...settings, props: { observability: { enabled: true } } };
  assert.throws(() => versionMetadata(changed), /script-settings-change/);
  const attempt = preparedUpload();
  attempt.request.metadata.bindings = [
    { type: "secret_text", name: "BASALT_RELEASE_ATTEMPT", text: "never-upload" },
  ];
  assert.throws(() => versionMetadata(attempt), /attempt-value-in-worker/);
});

test("empty migrations need no migration tag GET when the exact local DO classes match", () => {
  const input = preparedUpload();
  input.request.metadata.bindings = [
    { type: "durable_object_namespace", name: "Store", className: "Store" },
  ];
  const output = versionMetadata({
    ...input,
    previousSettings: {
      tags: ["alchemy:migration-tag:1"],
      bindings: [
        {
          type: "durable_object_namespace",
          name: "Store",
          className: "Store",
          namespaceId: "existing-namespace",
        },
      ],
    },
  });
  assert.equal(output.migrations, undefined);
  assert.equal(output.bindings?.length, 1);
});

test("observed script defaults may extend unchanged explicitly configured settings", () => {
  const input = preparedUpload();
  input.request.metadata.observability = {
    enabled: true,
    logs: { enabled: true, invocationLogs: true },
  };
  input.previousSettings!.observability = {
    enabled: true,
    headSamplingRate: 1,
    logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
  };
  assert.doesNotThrow(() => versionMetadata(input));
  input.previousSettings!.observability.logs!.enabled = false;
  assert.throws(() => versionMetadata(input), /script-settings-drift/);
});
