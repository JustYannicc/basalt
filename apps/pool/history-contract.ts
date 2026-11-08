import type { Result } from "./control.ts";

export interface HistoryBounds {
  readonly from: string;
  /** Exclusive end, matching the retained-history reader. */
  readonly to: string;
}

export interface HistoryCursor {
  readonly timestamp: string;
  readonly id: string;
}

export interface PublicHistoryQuery extends HistoryBounds {
  readonly after?: HistoryCursor;
}

/** Public history intentionally carries metadata only; request and response content never crosses. */
export interface PublicHistoryRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly person: string | null;
  readonly request_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly endpoint: string | null;
  readonly api_type: string | null;
  readonly service_tier: string | null;
  readonly input_tokens: string | null;
  readonly output_tokens: string | null;
  readonly cache_read_tokens: string | null;
  readonly cache_write_tokens: string | null;
  readonly reasoning_tokens: string | null;
  readonly total_tokens: string | null;
  readonly token_quality: "complete" | "legacy" | "unclassified" | "inconsistent";
  readonly latency_ms: string | null;
  readonly failed: boolean;
  readonly status_code: number | null;
  readonly cost: string | null;
  readonly currency: string | null;
  readonly cost_basis: "home-charge" | "historical-api-price" | "unpriced";
  readonly attribution: "charge-snapshot" | "key-at-capture" | "import-owner" | "unknown";
}

export interface PublicHistoryPage {
  readonly records: readonly PublicHistoryRecord[];
  readonly next: HistoryCursor | null;
}

export type PublicHistoryReader = (input: PublicHistoryQuery) => Promise<Result<PublicHistoryPage>>;
