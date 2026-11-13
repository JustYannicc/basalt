import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { discoverScriptSettings } from "../../scripts/architecture/native-stack.ts";
import { preparedUpload } from "../../scripts/release-barrier/fixture.ts";
import { freezeUpload } from "../../scripts/release-barrier/version-request.ts";
import { workerObservability } from "../telemetry/deployment.ts";
import { routeBulkImport } from "./model-history/bulk-http.ts";
import { bulkImportPath } from "./model-history/bulk-contract.ts";
import { signEnvelope } from "./token.ts";

const rows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      role: Schema.String,
      scriptName: Schema.String,
      metadata: Schema.toType(Workers.PutScriptMetadata),
    }),
  ),
)(discoverScriptSettings(process.cwd()));
const declaration = rows.find((row) => row.role === "PoolWorker");
assert.ok(declaration);
const original = preparedUpload("PoolWorker");
const upload = {
  ...original,
  request: {
    ...original.request,
    scriptName: declaration.scriptName,
    metadata: { ...original.request.metadata, ...declaration.metadata, migrations: undefined },
  },
  previousSettings: {
    bindings: [
      {
        type: "durable_object_namespace" as const,
        name: "PoolContainer",
        className: "PoolContainer",
      },
    ],
    tags: [
      "alchemy:stack:basalt",
      "alchemy:stage:production",
      "alchemy:id:PoolWorker",
      "alchemy:dos:PoolContainer",
    ],
    observability: workerObservability,
  },
};
const baseline = [{ versionId: "b80-pool-version", percentage: 100 }];
const versions = [
  {
    id: "b80-pool-version",
    bindings: [{ type: "plain_text", name: "POOL_IMAGE_HASH", text: "c1fbe678054e1f4d" }],
  },
];

test("the deployed PoolWorker declaration admits the existing PoolContainer baseline", async () => {
  await assert.doesNotReject(() => freezeUpload(upload, baseline, versions));
});

test("the b81 undeclared BulkUsageImport addition still refuses before upload", async () => {
  const b81 = {
    ...upload,
    request: {
      ...upload.request,
      metadata: {
        ...upload.request.metadata,
        bindings: [
          ...upload.previousSettings.bindings,
          {
            type: "durable_object_namespace" as const,
            name: "BulkUsageImport",
            className: "BulkUsageImport",
          },
        ],
        tags: upload.previousSettings.tags.map((tag) =>
          tag === "alchemy:dos:PoolContainer" ? "alchemy:dos:BulkUsageImport;PoolContainer" : tag,
        ),
      },
    },
  };
  await assert.rejects(() => freezeUpload(b81, baseline, versions), /durable-object-class-drift/);
});

test("an authenticated bulk command refuses with its provisioning code before job work", async () => {
  const key = "ab".repeat(32);
  const envelope = await signEnvelope(key, "sbs1", {
    action: "importUsageBulk",
    pool: "fixture-pool",
    organization: "fixture-org",
    owner: "fixture-owner",
    user: "fixture-owner",
    expiresAt: Date.now() + 25_000,
    input: { operation: "status", job: "a".repeat(64) },
  });
  const response = await routeBulkImport(
    new Request(`https://pool.example${bulkImportPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    { signingKey: key },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "bulk_import_not_provisioned",
    message: "Bulk import is not provisioned yet.",
  });
});
