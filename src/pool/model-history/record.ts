import { digest } from "../backend-users.ts";

export interface ModelRequest {
  id: string;
  source: string;
  sourceRecord: string;
  timestamp: string;
  pool: string | null;
  person: string | null;
  account: string | null;
  clientKey: string | null;
  requestId: string | null;
  provider: string | null;
  model: string;
  endpoint: string | null;
  apiType: string | null;
  serviceTier: string | null;
  inputTokens: string | null;
  outputTokens: string | null;
  cacheReadTokens: string | null;
  cacheWriteTokens: string | null;
  reasoningTokens: string | null;
  totalTokens: string | null;
  tokenQuality: "complete" | "legacy" | "unclassified" | "inconsistent";
  latencyMs: string | null;
  failed: boolean;
  statusCode: number | null;
  cost: string | null;
  currency: string | null;
  costBasis: "home-charge" | "historical-api-price" | "unpriced";
  priceVersion: string | null;
  price: HistoryPrice | null;
  attribution: "charge-snapshot" | "key-at-capture" | "import-owner" | "unknown";
}

export interface HistoryPrice {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  request: string;
  tier: string | null;
  minInput: string;
  validFrom: string | null;
  validTo: string | null;
}

/** Deliberately fixed text: a parser failure must not echo an export or driver value. */
export class HistoryInputError extends Error {
  constructor() { super("Invalid model usage metadata"); }
}
export const invalidHistory = (): never => { throw new HistoryInputError(); };

export function historyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidHistory();
  return value as Record<string, unknown>;
}

export function counter(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return invalidHistory();
    return String(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)
    || BigInt(value) > 9_223_372_036_854_775_807n) return invalidHistory();
  return value;
}

export function identifier(value: unknown, required = false): string | null {
  if (value === undefined || value === null || value === "") return required ? invalidHistory() : null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,255}$/.test(value)) return invalidHistory();
  return value;
}

export function timestamp(value: unknown): string {
  // Keep fractional digits: Date.toISOString() would merge distinct microsecond records.
  const parts = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!parts) return invalidHistory();
  const local = Date.parse(`${parts[1]}Z`), at = Date.parse(`${parts[1]}${parts[3]}`);
  if (!Number.isFinite(local) || !Number.isFinite(at) || new Date(local).toISOString().slice(0, 19) !== parts[1]
    || at < 0 || at >= Date.parse("9999-01-01T00:00:00Z")) return invalidHistory();
  return `${new Date(at).toISOString().slice(0, 19)}.${(parts[2] ?? "").padEnd(9, "0")}Z`;
}

export function amount(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) return invalidHistory();
    value = value.toFixed(12);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,9})(?:\.[0-9]{1,12})?$/.test(value)) return invalidHistory();
  return value;
}

const endpoints: Record<string, string> = {
  "/v1/chat/completions": "chat-completions", "/v1/responses": "responses", "/v1/responses/compact": "responses-compact",
  "/v1/messages": "messages", "/v1/embeddings": "embeddings", "/v1/completions": "completions",
  "/v1/images/generations": "image-generation", "/v1/images/edits": "image-edit", "/v1/audio/transcriptions": "transcription",
};
export function endpointMetadata(value: unknown): Pick<ModelRequest, "endpoint" | "apiType"> {
  if (typeof value === "string" && Object.hasOwn(endpoints, value)) return { endpoint: value, apiType: endpoints[value]! };
  // Gemini paths contain a model id; keep only the API shape, never an arbitrary path/query.
  if (typeof value === "string" && /^\/v1beta\/models\/[A-Za-z0-9._-]+:(?:streamGenerateContent|generateContent)$/.test(value))
    return { endpoint: "/v1beta/models/:model:generateContent", apiType: "generate-content" };
  return { endpoint: null, apiType: null };
}

export async function reference(source: string, kind: string, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return invalidHistory();
  if (String(value).length > 4096) return invalidHistory();
  return digest(JSON.stringify([source, kind, String(value)]));
}

/** Price identities include only numeric rates and closed billing dimensions. */
export function homePrice(raw: Record<string, unknown>): HistoryPrice {
  const rates = ["input", "output", "cache_read", "cache_write"].map((name) => amount(raw[`${name}_price_per_million`]));
  if (rates.some((rate) => rate === null)) return invalidHistory();
  return { input: rates[0]!, output: rates[1]!, cacheRead: rates[2]!, cacheWrite: rates[3]!,
    request: amount(raw.request_price) ?? "0", tier: raw.matched_service_tier === "*" ? "*" : identifier(raw.matched_service_tier),
    minInput: counter(raw.min_input_tokens) ?? "0", validFrom: null, validTo: null };
}
