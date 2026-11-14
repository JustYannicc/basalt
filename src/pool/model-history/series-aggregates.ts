export const tokenColumns = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_tokens",
  cacheWrite: "cache_write_tokens",
  reasoning: "reasoning_tokens",
  total: "total_tokens",
} as const;

/** Shared aggregate columns preserve series redaction and valuation semantics. */
export function seriesAggregates(priced: boolean, limited = false) {
  const columns = Object.entries(tokenColumns).flatMap(([name, column]) => [
    `sum(${column})::text AS "${name}Sum"`,
    `count(${column})::text AS "${name}Known"`,
    `count(*) FILTER (WHERE ${column} IS NULL)::text AS "${name}Missing"`,
  ]);
  return [
    "count(*)::text AS requests",
    "count(*) FILTER (WHERE failed)::text AS failed",
    ...(limited ? ["count(*) FILTER (WHERE status_code = 429)::text AS limited"] : []),
    "count(*) FILTER (WHERE failed AND account IS NULL AND source = $6)::text AS unassigned",
    "max(timestamp_exact) FILTER (WHERE NOT failed) AS last_success",
    ...columns,
    ...["complete", "legacy", "unclassified", "inconsistent"].map(
      (quality) => `count(*) FILTER (WHERE token_quality = '${quality}')::text AS ${quality}`,
    ),
    "sum(cost) FILTER (WHERE cost_basis = 'home-charge')::text AS home_amount",
    "count(*) FILTER (WHERE cost_basis = 'home-charge')::text AS home_priced",
    "sum(cost) FILTER (WHERE cost_basis = 'historical-api-price' AND currency = 'USD')::text AS imported_amount",
    "count(*) FILTER (WHERE cost_basis = 'historical-api-price' AND currency = 'USD')::text AS imported_priced",
    "count(*) FILTER (WHERE cost_basis = 'unpriced')::text AS unpriced",
    ...["charge-snapshot", "key-at-capture", "import-owner", "unknown"].map(
      (kind) => `count(*) FILTER (WHERE attribution = '${kind}')::text AS "${kind}"`,
    ),
    ...(priced
      ? [
          "round(sum(api_cost),12)::text AS api_amount",
          "count(api_cost)::text AS api_priced",
          "count(*) FILTER (WHERE api_cost IS NOT NULL AND token_count_estimate)::text AS api_token_count_estimates",
          "min(public_price_as_of) FILTER (WHERE api_cost IS NOT NULL) AS api_price_as_of",
          "string_agg(DISTINCT public_price_version, ',' ORDER BY public_price_version) FILTER (WHERE api_cost IS NOT NULL) AS api_price_version",
          "bool_or(public_price_basis='baseline') FILTER (WHERE api_cost IS NOT NULL) AS api_price_baseline",
          "bool_or(public_price_refresh_failed) FILTER (WHERE api_cost IS NOT NULL) AS api_price_refresh_failed",
          "count(*) FILTER (WHERE public_price_version IS NULL)::text AS api_missing_prices",
          "count(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL OR cache_read_tokens IS NULL OR cache_write_tokens IS NULL OR token_quality NOT IN ('complete','legacy'))::text AS api_missing_tokens",
        ]
      : []),
    "bool_or(counts_only) AS counts_only",
  ];
}
