/** Trusted query fragments for current API prices and request-level percentiles. */
export function priceQuery(personScoped = false) {
  return `WITH visible_refs AS (
      SELECT h.history_ref AS account, min(a.offering) AS offering
      FROM jsonb_to_recordset($3::jsonb) AS a(account text, offering text, history text[])
      CROSS JOIN LATERAL unnest(a.history) AS h(history_ref)
      WHERE a.account IS NOT NULL
      GROUP BY h.history_ref
    ), selected AS (
      SELECT CASE WHEN r.person=ANY($6::character(64)[]) THEN r.person::text ELSE NULL END AS person,
        r.source,r.provider,r.model,r.timestamp_exact,r.failed,r.total_tokens,r.token_quality,r.api_type,
        r.input_tokens,r.output_tokens,r.cache_read_tokens,r.cache_write_tokens,r.service_tier,
        CASE WHEN r.token_quality='complete' OR r.token_quality='legacy' AND r.api_type IN ('responses','responses-compact')
          THEN r.input_tokens::numeric
          WHEN r.token_quality='legacy' AND r.api_type='messages'
          THEN r.input_tokens::numeric+coalesce(r.cache_read_tokens,0)::numeric+coalesce(r.cache_write_tokens,0)::numeric
          ELSE NULL END AS context_input,
        CASE WHEN r.source<>$8 THEN 'excluded'
          WHEN r.account IS NULL THEN 'unknown'
          WHEN refs.offering IN ('subscription','metered_api') THEN refs.offering ELSE 'unknown' END AS offering
      FROM basalt_model_requests r LEFT JOIN visible_refs refs ON refs.account=r.account::text
      WHERE r.pool=$1 AND r.source=ANY($2::character(64)[]) AND r.timestamp_exact >= $4 AND r.timestamp_exact < $5
        AND (r.account IS NULL OR refs.account IS NOT NULL)
        ${personScoped ? "AND r.person = ANY($9::character(64)[]) AND r.attribution IS DISTINCT FROM 'import-owner'" : ""}
    ), priced AS (
      SELECT s.*,p.price_version,p.price_as_of,
        CASE WHEN p.price_version IS NULL OR s.token_quality NOT IN ('complete','legacy')
          OR s.input_tokens IS NULL OR s.output_tokens IS NULL OR s.cache_read_tokens IS NULL OR s.cache_write_tokens IS NULL
          OR (s.token_quality='complete' AND s.input_tokens::numeric < s.cache_read_tokens::numeric+s.cache_write_tokens::numeric)
          THEN NULL
        WHEN s.token_quality='complete' THEN
          ((s.input_tokens::numeric-s.cache_read_tokens::numeric-s.cache_write_tokens::numeric)*p.input_rate
          + s.output_tokens::numeric*p.output_rate + s.cache_read_tokens::numeric*p.cache_read_rate
          + CASE WHEN p.cache_write_rate=0 THEN s.cache_write_tokens::numeric*p.input_rate
            ELSE s.cache_write_tokens::numeric*p.cache_write_rate END)/1000000 + p.request_rate
        WHEN s.api_type IN ('responses','responses-compact') THEN
          (GREATEST(s.input_tokens::numeric-s.cache_read_tokens::numeric
            - CASE WHEN p.cache_write_rate>0 THEN s.cache_write_tokens::numeric ELSE 0 END, 0)*p.input_rate
          + s.output_tokens::numeric*p.output_rate + s.cache_read_tokens::numeric*p.cache_read_rate
          + CASE WHEN p.cache_write_rate>0 THEN s.cache_write_tokens::numeric*p.cache_write_rate ELSE 0 END)/1000000 + p.request_rate
        WHEN s.api_type='messages' THEN
          (s.input_tokens::numeric*p.input_rate + s.output_tokens::numeric*p.output_rate
          + s.cache_read_tokens::numeric*p.cache_read_rate + s.cache_write_tokens::numeric*p.cache_write_rate)/1000000 + p.request_rate
        ELSE NULL END AS api_cost
      FROM selected s LEFT JOIN LATERAL (
        SELECT version AS price_version,as_of AS price_as_of,input::numeric AS input_rate,output::numeric AS output_rate,
          cache_read::numeric AS cache_read_rate,cache_write::numeric AS cache_write_rate,request::numeric AS request_rate
        FROM jsonb_to_recordset($7::jsonb) AS x(provider text,model text,currency text,input text,output text,
          cache_read text,cache_write text,request text,tier text,min_input text,as_of text,source text,version text)
        WHERE x.provider=s.provider AND x.model=s.model AND x.currency='USD' AND x.source='models.dev'
          AND (x.tier='*' OR x.tier=coalesce(s.service_tier,'*')) AND x.min_input::numeric<=coalesce(s.context_input,0)
        ORDER BY (x.tier<>'*') DESC,x.min_input::numeric DESC LIMIT 1
      ) p ON true
    ) `;
}

export const percentileSql = (
  columns: string,
  groupBy: string,
  maxDimensionRows: number,
) => `SELECT ${columns},
  count(*) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy'))::text AS known,
  count(*) FILTER (WHERE total_tokens IS NULL OR token_quality NOT IN ('complete','legacy'))::text AS missing,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p50,
  percentile_disc(0.9) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p90,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p99
  FROM priced ${groupBy ? `GROUP BY ${groupBy}` : ""} ORDER BY ${groupBy || "1"} LIMIT ${maxDimensionRows + 1}`;
