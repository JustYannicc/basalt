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

const counters = (record: PublicHistoryRecord) => [
  record.input_tokens,
  record.output_tokens,
  record.cache_read_tokens,
  record.cache_write_tokens,
  record.reasoning_tokens,
  record.total_tokens,
];

// Anything that isn't plainly absent or zero counts as recorded, so odd values never hide usage.
const nothing = (value: string | null) => value === null || /^0+(?:\.0+)?$/.test(value);

/** A failure with no counters and no positive retained or estimated cost, whatever its model. */
export const failedRecordWithoutUsage = (record: PublicHistoryRecord) =>
  record.failed &&
  counters(record).every(nothing) &&
  nothing(record.cost) &&
  nothing(record.api_estimate?.amount ?? null);

/** The recorded model wins; only unnamed no-usage failures read as a generic failed request. */
export const requestTitle = (record: PublicHistoryRecord) =>
  record.model ?? (failedRecordWithoutUsage(record) ? "Failed request" : "Model not recorded");
