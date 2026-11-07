import type { SqlValue } from "@sqlite.org/sqlite-wasm";

const safeLabel = (value: SqlValue | undefined) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:@+\-]{0,255}$/.test(value) ? value : null;
const counter = (value: SqlValue | undefined) => {
  if (value === null) return null;
  if (
    (typeof value !== "bigint" && !(typeof value === "number" && Number.isSafeInteger(value))) ||
    value < 0
  )
    throw new Error("The backup contains an invalid usage counter.");
  return String(value);
};
async function reference(kind: string, value: SqlValue | undefined) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number")
    throw new Error("The backup contains invalid account metadata.");
  const bytes = new TextEncoder().encode(
    JSON.stringify(["cpamp-upload-reference-v1", kind, String(value)]),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Explicit allowlist matches the retained Manager Plus usage_events schema. No payload SELECT. */
export const sqliteColumns = [
  "id",
  "event_hash",
  "timestamp",
  "provider",
  "model",
  "endpoint",
  "service_tier",
  "request_id",
  "auth_index",
  "api_key_hash",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
  "total_tokens",
  "latency_ms",
  "failed",
  "fail_status_code",
];

export async function sqliteMetadata(row: Record<string, SqlValue>) {
  if (
    typeof row.event_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.event_hash) ||
    typeof row.timestamp !== "string" ||
    !Number.isFinite(Date.parse(row.timestamp)) ||
    (row.failed !== 0 && row.failed !== 1)
  )
    throw new Error("The backup contains invalid usage records.");
  const endpoint =
    typeof row.endpoint === "string" &&
    (/^\/v1\/(chat\/completions|responses(?:\/compact)?|messages|embeddings|completions|images\/(generations|edits)|audio\/transcriptions)$/.test(
      row.endpoint,
    ) ||
      /^\/v1beta\/models\/[A-Za-z0-9._-]+:(streamGenerateContent|generateContent)$/.test(
        row.endpoint,
      ))
      ? row.endpoint
      : null;
  const status = row.failed === 1 ? counter(row.fail_status_code) : null;
  const statusCode = status === null || status === "0" ? null : Number(status);
  if (statusCode !== null && (statusCode < 100 || statusCode > 599))
    throw new Error("The backup contains an invalid HTTP status.");
  return {
    event_hash: row.event_hash,
    timestamp: row.timestamp,
    provider: safeLabel(row.provider),
    model: safeLabel(row.model),
    endpoint,
    service_tier: safeLabel(row.service_tier),
    request_id: await reference("request", row.request_id),
    account_ref: await reference("account", row.auth_index),
    client_key_ref: await reference("key", row.api_key_hash),
    input_tokens: counter(row.input_tokens),
    output_tokens: counter(row.output_tokens),
    cache_read_tokens: counter(row.cache_read_tokens),
    cache_write_tokens: counter(row.cache_creation_tokens),
    reasoning_tokens: counter(row.reasoning_tokens),
    total_tokens: counter(row.total_tokens),
    latency_ms: counter(row.latency_ms),
    failed: row.failed === 1,
    status_code: statusCode,
  };
}
