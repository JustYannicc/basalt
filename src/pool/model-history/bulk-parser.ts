import { digest } from "../backend-users.ts";
import { bulkInteger, maximumBulkChunkBytes, type BulkDefinition } from "./bulk-contract.ts";
import { parseBulkUsageImport } from "./import.ts";
import { invalidHistory } from "./record.ts";

const metadataFields = new Set([
  "source_id",
  "event_hash",
  "timestamp",
  "provider",
  "model",
  "endpoint",
  "service_tier",
  "request_id",
  "account_ref",
  "client_key_ref",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "total_tokens",
  "latency_ms",
  "failed",
  "status_code",
  "generate",
]);

export async function parseBulkChunk(definition: BulkDefinition, index: number, data: string) {
  bulkInteger(index, 0, definition.manifest.chunks.length - 1);
  const chunk = definition.manifest.chunks[index]!;
  const bytes = new TextEncoder().encode(data).byteLength;
  if (
    bytes !== chunk.bytes ||
    bytes > maximumBulkChunkBytes ||
    (await digest(data)) !== chunk.sha256
  )
    return invalidHistory();
  for (const line of data.split(/\r?\n/).filter((line) => line.trim())) {
    const raw = JSON.parse(line);
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !metadataFields.has(key))
    )
      return invalidHistory();
  }
  const parsed = await parseBulkUsageImport(
    {
      source: definition.manifest.source,
      format: "cpamp-v1-jsonl",
      data,
      accountMappings: definition.accountMappings,
    },
    { pool: definition.identity.pool, person: definition.identity.owner },
  );
  if (
    parsed.next !== null ||
    parsed.records.length !== chunk.rows ||
    new Set(parsed.records.map((row) => row.id)).size !== chunk.rows ||
    (await digest(JSON.stringify(parsed.records.map((row) => row.id)))) !== chunk.idsSha256
  )
    return invalidHistory();
  return parsed.records;
}
