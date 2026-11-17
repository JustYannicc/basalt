import { digest } from "../../src/pool/backend-users.ts";
import { parseBulkUsageImport } from "../../src/pool/model-history/import.ts";
import type { BulkDefinition } from "../../src/pool/model-history/bulk-contract.ts";

export async function bulkProgressFixture(schema: string, count = 4) {
  const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const identity = {
    pool: "app_bulk_progress_fixture",
    organization: "fixture-org",
    owner: "fixture-owner",
  };
  const data = Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      source_id: index + 1,
      event_hash: index.toString(16).padStart(64, "0"),
      timestamp: "2026-01-01T00:00:00Z",
      failed: false,
      total_tokens: index,
    }),
  ).join("\n");
  const parsed = await parseBulkUsageImport(
    { source, format: "cpamp-v1-jsonl", data, accountMappings: [] },
    { pool: identity.pool, person: identity.owner },
  );
  const definition: BulkDefinition = {
    job: await digest("fixture-job"),
    identity,
    manifestDigest: await digest("fixture-manifest"),
    accountMappingDigest: await digest("fixture-mappings"),
    accountMappings: [],
    manifest: {
      version: 1,
      source,
      sourceHash: await digest(data),
      approvedManifestSha256: await digest("fixture-approved-manifest"),
      accountMappingDigest: await digest("fixture-mappings"),
      totalRows: count,
      chunks: [
        {
          sha256: await digest(data),
          idsSha256: await digest(JSON.stringify(parsed.records.map((row) => row.id))),
          rows: count,
          bytes: Buffer.byteLength(data),
        },
      ],
    },
  };
  // The shared fixture has already refused every non-loopback database URL.
  const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return { definition, data, records: parsed.records, connectionString: url.href };
}
