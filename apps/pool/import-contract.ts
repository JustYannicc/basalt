export type UsageImportFormat = "cpamp-v1-jsonl" | "home-v8-jsonl" | "cpa-v6";

export interface UsageImportPage {
  format: UsageImportFormat;
  data: string;
  /** Reuse one name for backups of the same source database; use distinct names for others. */
  source: string;
  offset?: number;
  mode: "dry-run" | "apply";
  approval?: string;
}

export interface UsageImportResult {
  mode: "dry-run" | "apply";
  totalDetails: number;
  pageDetails: number;
  existing: number;
  wouldInsert: number;
  inserted: number;
  unpriced: number;
  next: number | null;
  approval: string | null;
  from: string | null;
  to: string | null;
  aggregateOnlyNotImportable: string;
  indistinguishableDetails: number;
}
