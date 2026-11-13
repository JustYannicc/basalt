import type {
  OverviewMoneyMetric,
  OverviewPriceTable,
} from "../../../apps/pool/overview-contract.ts";
import { digest } from "../backend-users.ts";
import { officialPriceRows } from "./official-cost.ts";
import { pricedRowsSql } from "./overview-sql.ts";
import type { HistoryDatabase } from "./schema.ts";
import { readRequests, type HistoryQuery } from "./store.ts";

export type HistoryPrices = (
  targets: readonly { provider: string; model: string }[],
) => Promise<OverviewPriceTable>;

async function pricedPage(db: HistoryDatabase, query: HistoryQuery, currentPrices?: HistoryPrices) {
  const page = await readRequests(db, query);
  if (!page.records.length) return page;
  const source = await digest("home-local-v1");
  const targets = [
    ...new Map(
      page.records.flatMap((row) =>
        row.source === source && typeof row.provider === "string" && typeof row.model === "string"
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
  const result = await db.query(
    `WITH selected AS (
      SELECT r.* FROM unnest($1::character(64)[]) AS ids(id)
      CROSS JOIN LATERAL (SELECT * FROM basalt_model_requests
        WHERE id=ids.id AND pool=$4 AND ($5::text IS NULL OR person=$5) LIMIT 1) r
    ), ${pricedRowsSql("selected", "$2", "s.source=$3", "public_")}
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
  );
  const estimates = new Map(result.rows.map((row) => [row.id, row]));
  return {
    ...page,
    records: page.records.map((record) => {
      const row = estimates.get(record.id);
      const amount = typeof row?.amount === "string" ? row.amount : null;
      const missing =
        record.source !== source
          ? "Current API estimates are unavailable for imported records."
          : record.model === null
            ? "Model not recorded; cost cannot be estimated."
            : [
                  record.input_tokens,
                  record.output_tokens,
                  record.cache_read_tokens,
                  record.cache_write_tokens,
                ].some((value) => value === null)
              ? "Request token counts are missing or incomplete."
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
      return { ...record, api_estimate: metric };
    }),
  };
}

/** A page's retained metadata and current valuation share one bounded read snapshot. */
export async function readPricedRequests(
  db: HistoryDatabase,
  query: HistoryQuery,
  prices?: HistoryPrices,
) {
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await pricedPage(db, query, prices);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
