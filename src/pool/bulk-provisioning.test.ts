import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { discoverScriptSettings } from "../../scripts/architecture/native-stack.ts";
import { preparedUpload } from "../../scripts/release-barrier/fixture.ts";
import {
  freezeUpload,
  type WorkerVersionInput,
} from "../../scripts/release-barrier/version-request.ts";
import { declaredClassSettings } from "../../scripts/release-barrier/declared-class-contract.ts";
import { poolWorkerClassEntry } from "../../scripts/release-barrier/test/repository-declarations.ts";
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
    placement: undefined,
    bindings: [{ type: "plain_text", name: "POOL_IMAGE_HASH", text: "c1fbe678054e1f4d" }],
  },
];

const entries = [await poolWorkerClassEntry()];
// The read-only baseline probe runs before the class step, so it admits through the same projection.
const beforeClassStep = (value: WorkerVersionInput) => ({
  ...value,
  previousSettings: declaredClassSettings(
    value.previousSettings!,
    value.request.metadata,
    entries,
    value.fqn,
    value.request.scriptName,
  ),
});

test("the deployed PoolWorker declaration admits the existing PoolContainer baseline", async () => {
  await assert.doesNotReject(() => freezeUpload(beforeClassStep(upload), baseline, versions));
});

test("once the declared fleet classes are live the PoolWorker declaration admits unprojected", async () => {
  const live = {
    ...upload,
    previousSettings: {
      ...upload.previousSettings,
      bindings: declaration.metadata.bindings!.filter(
        (binding) => binding.type === "durable_object_namespace",
      ),
      tags: declaration.metadata.tags,
    },
  };
  assert.equal(beforeClassStep(live).previousSettings, live.previousSettings);
  await assert.doesNotReject(() => freezeUpload(beforeClassStep(live), baseline, versions));
});

const withBulkImport = (value: typeof upload) => ({
  ...value,
  request: {
    ...value.request,
    metadata: {
      ...value.request.metadata,
      bindings: [
        ...(value.request.metadata.bindings ?? []),
        {
          type: "durable_object_namespace" as const,
          name: "BulkUsageImport",
          className: "BulkUsageImport",
        },
      ],
    },
  },
});

test("the b81 undeclared BulkUsageImport addition still refuses before upload", async () => {
  const b81 = withBulkImport({
    ...upload,
    request: {
      ...upload.request,
      metadata: {
        ...upload.request.metadata,
        bindings: [...upload.previousSettings.bindings],
        tags: upload.previousSettings.tags.map((tag) =>
          tag === "alchemy:dos:PoolContainer" ? "alchemy:dos:BulkUsageImport;PoolContainer" : tag,
        ),
      },
    },
  });
  await assert.rejects(() => freezeUpload(b81, baseline, versions), /durable-object-class-drift/);
  await assert.rejects(
    () => freezeUpload(beforeClassStep(b81), baseline, versions),
    /durable-object-class-drift/,
  );
});

test("an undeclared class beside the declared fleet classes refuses before upload", async () => {
  await assert.rejects(
    async () => freezeUpload(beforeClassStep(withBulkImport(upload)), baseline, versions),
    /declared-class-binding-mismatch/,
  );
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
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "bulk_import_not_provisioned",
    message: "Bulk import is not provisioned yet.",
  });
});

test("a bound bulk route uses a reserved coordinator object name", async () => {
  const key = "ab".repeat(32);
  const job = "b".repeat(64);
  const envelope = await signEnvelope(key, "sbs1", {
    action: "importUsageBulk",
    pool: "fixture-pool",
    organization: "fixture-org",
    owner: "fixture-owner",
    user: "fixture-owner",
    expiresAt: Date.now() + 25_000,
    input: { operation: "status", job },
  });
  let objectName: string | undefined;
  const response = await routeBulkImport(
    new Request(`https://pool.example${bulkImportPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    {
      signingKey: key,
      jobs: {
        jurisdiction(region) {
          assert.equal(region, "eu");
          return {
            getByName(name) {
              objectName = name;
              return { fetch: async () => Response.json({ job }) };
            },
          };
        },
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { job });
  assert.equal(objectName, `bulk-usage-import:${job}`);
});
