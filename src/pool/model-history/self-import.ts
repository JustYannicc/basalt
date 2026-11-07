import type { UsageImportFormat, UsageImportPage } from "../../../apps/pool/import-contract.ts";
import { digest } from "../backend-users.ts";
import { maximumImportBytes, parseUsageImport } from "./import.ts";
import type { ModelRequest } from "./record.ts";
import { HistoryInputError, historyObject, invalidHistory } from "./record.ts";
import { historyBatchSize } from "./store.ts";

const importNamespace = "signalbox:pool:self-usage-import:v1";
const textEncoder = new TextEncoder();

function isImportFormat(value: unknown): value is UsageImportFormat {
  return value === "cpamp-v1-jsonl" || value === "home-v8-jsonl" || value === "cpa-v6";
}

export interface PreparedSelfImport {
  format: UsageImportFormat;
  offset: number;
  records: ModelRequest[];
  totalDetails: number;
  next: number | null;
  aggregateOnlyNotImportable: string;
  indistinguishableDetails: number;
}

async function sourceId(pool: string, format: UsageImportFormat): Promise<string> {
  // RFC 9562 UUIDv8: stable within a pool and format, with no filename or client identity.
  const name = textEncoder.encode(`${importNamespace}\u0000${pool}\u0000${format}`);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", name)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pageOffset(input: UsageImportPage): number {
  const offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > Number.MAX_SAFE_INTEGER - historyBatchSize
  )
    return invalidHistory();
  return offset;
}

function unpricedHomePage(data: string): string {
  return data
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return "";
      const row = historyObject(JSON.parse(line));
      return JSON.stringify({ ...row, amount: null, currency: null, matched_price_rule: null });
    })
    .join("\n");
}

/** Client pages are bounded metadata only; all identity and billing fields come from this adapter. */
export async function prepareSelfImport(
  input: UsageImportPage,
  identity: { pool: string; caller: string },
): Promise<PreparedSelfImport> {
  if (!isImportFormat(input.format)) return invalidHistory();
  if (
    typeof input.data !== "string" ||
    textEncoder.encode(input.data).byteLength > maximumImportBytes
  )
    return invalidHistory();

  const offset = pageOffset(input);
  if (input.format !== "cpa-v6") {
    const rows = input.data.split(/\r?\n/).filter((line) => line.trim()).length;
    if (rows > historyBatchSize) return invalidHistory();
  }

  const data = input.format === "home-v8-jsonl" ? unpricedHomePage(input.data) : input.data;
  const parsed = await parseUsageImport(
    {
      format: input.format,
      data,
      source: await sourceId(identity.pool, input.format),
      // JSONL requests already contain one 200-row client page. CPA snapshots are paged server-side.
      offset: input.format === "cpa-v6" ? offset : 0,
    },
    { pool: identity.pool, person: identity.caller },
  );
  if (parsed.records.length > historyBatchSize) return invalidHistory();

  const records = parsed.records.map((row): ModelRequest => ({
    ...row,
    person: null,
    cost: null,
    currency: null,
    costBasis: "unpriced",
    priceVersion: null,
    originalPriceRule: null,
    price: null,
    attribution: "import-owner",
  }));

  return {
    format: input.format,
    offset,
    records,
    totalDetails: input.format === "cpa-v6" ? parsed.report.totalDetails : offset + records.length,
    next:
      input.format === "cpa-v6"
        ? parsed.next
        : records.length === historyBatchSize
          ? offset + records.length
          : null,
    aggregateOnlyNotImportable: parsed.report.aggregateOnlyNotImportable,
    indistinguishableDetails: parsed.report.indistinguishableDetails,
  };
}

export function validateSelfImportPage(value: unknown): UsageImportPage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HistoryInputError();
  const input = historyObject(value);
  const format = input.format,
    data = input.data,
    mode = input.mode,
    offset = input.offset,
    approval = input.approval;
  const allowed = new Set(["format", "data", "offset", "mode", "approval"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new HistoryInputError();
  if (
    !isImportFormat(format) ||
    typeof data !== "string" ||
    (mode !== "dry-run" && mode !== "apply") ||
    (offset !== undefined && typeof offset !== "number") ||
    (approval !== undefined && typeof approval !== "string")
  )
    throw new HistoryInputError();
  if (approval !== undefined && approval.length > 4096) throw new HistoryInputError();
  return {
    format,
    data,
    mode,
    ...(offset === undefined ? {} : { offset }),
    ...(approval === undefined ? {} : { approval }),
  };
}
