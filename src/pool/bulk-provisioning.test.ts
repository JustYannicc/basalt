import assert from "node:assert/strict";
import { test } from "node:test";
import { routeBulkImport } from "./model-history/bulk-http.ts";
import { bulkImportPath } from "./model-history/bulk-contract.ts";
import { signEnvelope } from "./token.ts";

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
