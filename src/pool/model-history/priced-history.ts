import type {
  OverviewMoneyMetric,
  OverviewPriceTable,
} from "../../../apps/pool/overview-contract.ts";
import { digest } from "../backend-users.ts";
import { officialPriceRows } from "./official-cost.ts";
import { pricedRowsSql } from "./overview-sql.ts";
import { withHistoryDatabase } from "./database.ts";
import { readRequests, type HistoryQuery } from "./store.ts";

export type HistoryPrices = (
  targets: readonly { provider: string; model: string }[],
) => Promise<OverviewPriceTable>;

export async function readPricedRequests(
  connectionString: string | undefined,
  query: HistoryQuery,
  currentPrices?: HistoryPrices,
) {
  const page = await withHistoryDatabase(connectionString, (db) => readRequests(db, query));
  if (!page.records.length) return { ...page, records: [] };
  const source = await digest("home-local-v1");
  const targets = [
    ...new Map(
      page.records.flatMap((row) =>
        (row.source === source || row.attribution === "import-owner") &&
        typeof row.provider === "string" &&
        typeof row.model === "string"
          ? [
              [
                JSON.stringify([row.provider, row.model]),
                { provider: row.provider, model: row.model },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  let table: OverviewPriceTable = { prices: [], issues: [] };
  let unavailable = "Current API price data is unavailable.";
  if (currentPrices) {
    for (let offset = 0; offset < targets.length; offset += 100) {
      const targetsInBatch = targets.slice(offset, offset + 100);
      try {
        const batch = await currentPrices(targetsInBatch);
        table = {
          prices: [...table.prices, ...batch.prices],
          issues: [...table.issues, ...batch.issues],
        };
      } catch {
        unavailable = "Current API price data could not be read.";
        table = {
          ...table,
          issues: [
            ...table.issues,
            ...targetsInBatch.map((target) => ({ ...target, reason: unavailable })),
          ],
        };
      }
    }
  }
  // Price only the already-authorized page IDs. Each lookup uses the ledger's primary key.
  const result = await withHistoryDatabase(connectionString, (db) =>
    db.query(
      `WITH selected AS (
      SELECT r.* FROM unnest($1::character(64)[]) AS ids(id)
      CROSS JOIN LATERAL (SELECT * FROM basalt_model_requests
        WHERE id=ids.id AND pool=$4 AND ($5::text IS NULL OR person=$5) LIMIT 1) r
    ), ${pricedRowsSql("selected", "$2", "s.source=$3 OR s.attribution='import-owner'", "public_")}
    SELECT id,round(api_cost,12)::text AS amount,token_count_estimate,
      public_price_version,public_price_as_of,public_price_basis,public_price_refresh_failed
    FROM priced`,
      [
        page.records.map((row) => row.id),
        JSON.stringify(officialPriceRows(table.prices)),
        source,
        query.pool,
        query.person ?? null,
      ],
    ),
  );
  const estimates = new Map(result.rows.map((row) => [row.id, row]));
  return {
    ...page,
    records: page.records.map((record) => {
      const row = estimates.get(record.id);
      const amount = typeof row?.amount === "string" ? row.amount : null;
      const missingCounters = Object.entries({
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        cache_read_tokens: record.cache_read_tokens,
        cache_write_tokens: record.cache_write_tokens,
      })
        .filter(([, value]) => value === null)
        .map(([name]) => name);
      const missing =
        record.source !== source && record.attribution !== "import-owner"
          ? "This request source does not support current API estimates."
          : record.model === null
            ? "Model not recorded; cost cannot be estimated."
            : missingCounters.length
              ? `Request token counts are missing or incomplete: ${missingCounters.join(", ")}.`
              : row?.public_price_version == null
                ? (table.issues.find(
                    (issue) => issue.provider === record.provider && issue.model === record.model,
                  )?.reason ??
                  (table.prices.length ? `No public price for ${record.model}` : unavailable))
                : "Request tokens use an incomplete or unsupported accounting format.";
      const metric: OverviewMoneyMetric = {
        status: amount === null ? "unavailable" : "available",
        amount,
        currency: "USD",
        pricedRequests: amount === null ? 0 : 1,
        excluded: { unknownKind: 0, unknownKindValue: null, unpriced: amount === null ? 1 : 0 },
        ...(amount === null ? { reason: missing } : {}),
        price:
          amount === null || !row
            ? null
            : {
                source: "models.dev",
                version: String(row.public_price_version),
                asOf: String(row.public_price_as_of),
                basis: row.public_price_basis === "baseline" ? "baseline" : "live",
                ...(row.public_price_refresh_failed === true ? { refreshFailed: true } : {}),
                ...(row.token_count_estimate === true ? { calculation: "token-counts" } : {}),
              },
      };
      const enriched: typeof record & { api_estimate: OverviewMoneyMetric } = {
        ...record,
        api_estimate: metric,
      };
      return enriched;
    }),
  };
}
