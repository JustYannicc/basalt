import type { PublicHistoryRecord } from "../history-contract.ts";
import type { SeriesBucket } from "../usage-series-contract.ts";
import type { Totals } from "./series-model.ts";

export const failedBucketWithoutUsage = (bucket: SeriesBucket) =>
  bucket.requests > 0 &&
  bucket.failed === bucket.requests &&
  bucket.unassignedFailures === bucket.requests &&
  Object.values(bucket.tokens).every((token) => token.known === 0 && token.sum === null) &&
  bucket.cost.homeCharge.amount === null &&
  bucket.cost.importedApiPrice.amount === null &&
  (bucket.cost.apiEstimate?.amount ?? null) === null;

export const noRecordedUsage = (totals: Pick<Totals, "requests" | "failedWithoutUsage">) =>
  totals.requests > 0 && totals.failedWithoutUsage === totals.requests;

export const failedRecordWithoutUsage = (record: PublicHistoryRecord) =>
  record.failed &&
  record.api_type === "pool-protection-unavailable" &&
  record.model === null &&
  record.cost === null &&
  [
    record.input_tokens,
    record.output_tokens,
    record.cache_read_tokens,
    record.cache_write_tokens,
    record.reasoning_tokens,
    record.total_tokens,
  ].every((tokens) => tokens === null);
