import { sqliteSource } from "./sqlite-source.ts";
import type { UsageImportFormat, UsageImportPage, UsageImportResult } from "../import-contract.ts";

const maximumBytes = 8 * 1024 * 1024;
const pageSize = 200;
const encoder = new TextEncoder();

export interface ImportSource {
  readonly label: string;
  readonly format: UsageImportFormat;
  /** A new iterator rereads the selected local file; no source rows are retained between pages. */
  pages(): AsyncGenerator<ImportPage, void, UsageImportResult>;
}
export type ImportPage = Pick<UsageImportPage, "format" | "data" | "offset">;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("This file isn't a supported usage export.");
  return value as Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("This export contains invalid JSON. Choose a supported metadata export.");
  }
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new Error("This export contains invalid nested metadata.");
}

const common = [
  "timestamp",
  "failed",
  "provider",
  "model",
  "endpoint",
  "service_tier",
  "request_id",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
  "latency_ms",
];
const manager = [
  ...common,
  "event_hash",
  "account_ref",
  "client_key_ref",
  "cache_read_tokens",
  "cache_write_tokens",
  "status_code",
];
const home = [
  ...common,
  "usage_id",
  "credential_id",
  "auth_index",
  "api_key_id",
  "cached_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "error_status_code",
  "upstream_status_code",
  "token_breakdown_schema_version",
  "token_breakdown_quality",
  "token_breakdown_input_total_tokens",
  "token_breakdown_output_total_tokens",
  "token_breakdown_input_cache_read_tokens",
  "token_breakdown_input_cache_write_tokens",
  "token_breakdown_output_reasoning_tokens",
  "token_breakdown_total_tokens",
];

function pick(row: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => row[key] !== undefined).map((key) => [key, scalar(row[key])]),
  );
}

/** Parse byte-bounded UTF-8 lines, including characters split across File.slice boundaries. */
async function* lines(file: Blob) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for (let start = 0; start < file.size; start += 64 * 1024) {
    pending += decoder.decode(await file.slice(start, start + 64 * 1024).arrayBuffer(), {
      stream: true,
    });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      if (encoder.encode(line).byteLength > maximumBytes)
        throw new Error("A metadata record exceeds 8 MiB.");
      if (line.trim()) yield line;
    }
    if (encoder.encode(pending).byteLength > maximumBytes)
      throw new Error("A metadata record exceeds 8 MiB.");
  }
  pending += decoder.decode();
  if (pending.trim()) yield pending;
}

async function* jsonlPages(
  file: File,
  format: UsageImportFormat,
): AsyncGenerator<ImportPage, void, UsageImportResult> {
  let page: string[] = [],
    bytes = 0,
    offset = 0;
  for await (const line of lines(file)) {
    const row = object(parseJson(line));
    if (
      format === "cpamp-v1-jsonl" ? typeof row.event_hash !== "string" : row.usage_id === undefined
    )
      throw new Error("This export mixes unsupported record formats. Choose one metadata export.");
    const metadata = JSON.stringify(pick(row, format === "cpamp-v1-jsonl" ? manager : home));
    const size = encoder.encode(metadata).byteLength;
    if (page.length && (page.length === pageSize || bytes + size + 1 > maximumBytes)) {
      yield { format, data: page.join("\n"), offset };
      offset += page.length;
      page = [];
      bytes = 0;
    }
    page.push(metadata);
    bytes += size + 1;
  }
  if (page.length) yield { format, data: page.join("\n"), offset };
}

/** Strip non-metadata fields before a legacy snapshot leaves the device. */
async function opaqueReference(value: unknown) {
  if (value === undefined || value === null || value === "") return value;
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value)))
    throw new Error("This snapshot contains invalid account metadata.");
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function legacyMetadata(value: unknown) {
  const snapshot = object(value),
    usage = object(snapshot.usage),
    apis = object(usage.apis ?? {});
  if (snapshot.version !== 0 && snapshot.version !== 1)
    throw new Error("Choose a legacy CPA v0 or v1 snapshot.");
  return {
    version: snapshot.version,
    usage: {
      total_requests: scalar(usage.total_requests),
      apis: Object.fromEntries(
        await Promise.all(
          Object.entries(apis).map(async ([key, rawApi]) => {
            const api = object(rawApi),
              models = object(api.models ?? {});
            return [
              await opaqueReference(key),
              {
                models: Object.fromEntries(
                  await Promise.all(
                    Object.entries(models).map(async ([name, rawModel]) => {
                      const model = object(rawModel),
                        details = model.details ?? [];
                      if (!Array.isArray(details))
                        throw new Error("This snapshot has invalid request details.");
                      return [
                        name,
                        {
                          total_requests: scalar(model.total_requests),
                          details: await Promise.all(
                            details.map(async (raw) => {
                              const row = object(raw);
                              return {
                                ...pick(row, ["timestamp", "failed"]),
                                auth_index: await opaqueReference(row.auth_index),
                                source: await opaqueReference(row.source),
                                tokens: pick(object(row.tokens ?? {}), [
                                  "input_tokens",
                                  "output_tokens",
                                  "cached_tokens",
                                  "reasoning_tokens",
                                  "total_tokens",
                                ]),
                              };
                            }),
                          ),
                        },
                      ];
                    }),
                  ),
                ),
              },
            ];
          }),
        ),
      ),
    },
  };
}

export async function openImportSource(file: File): Promise<ImportSource> {
  if (file.size === 0)
    throw new Error("This file is empty. Choose a usage export with retained records.");
  const header = new TextDecoder().decode(await file.slice(0, 16).arrayBuffer());
  if (header.startsWith("SQLite format 3")) {
    if (file.size < 100) throw new Error("This SQLite backup is incomplete.");
    return sqliteSource(file);
  }
  const first = await lines(file).next();
  if (first.done) throw new Error("This file has no usage records.");
  let row: Record<string, unknown> | undefined;
  try {
    row = object(parseJson(first.value));
  } catch {
    /* Pretty-printed CPA snapshots are read below. */
  }
  const format =
    row?.event_hash !== undefined
      ? "cpamp-v1-jsonl"
      : row?.usage_id !== undefined
        ? "home-v8-jsonl"
        : "cpa-v6";
  if (format !== "cpa-v6")
    return { label: file.name, format, pages: () => jsonlPages(file, format) };
  if (file.size > maximumBytes)
    throw new Error(
      "Legacy CPA snapshots must be at most 8 MiB. Use prepared metadata JSONL for larger history.",
    );
  const data = JSON.stringify(await legacyMetadata(parseJson(await file.text())));
  return {
    label: file.name,
    format,
    async *pages() {
      let offset = 0;
      for (;;) {
        const report = yield { format, data, offset };
        if (report.next === null) return;
        if (!Number.isSafeInteger(report.next) || report.next <= offset)
          throw new Error("The pool returned invalid import progress. Nothing else was sent.");
        offset = report.next;
      }
    },
  };
}

export async function importPageDigest(page: ImportPage) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(page)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
