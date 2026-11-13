/** Reconstruct a token partition when old captures have no usable API metadata. */
export const counterShapeSql = `
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN s.input_tokens::numeric < s.cache_read_tokens::numeric+s.cache_write_tokens::numeric THEN true
      WHEN s.total_tokens::numeric IN (
        s.input_tokens::numeric+s.output_tokens::numeric,
        s.input_tokens::numeric+s.output_tokens::numeric+coalesce(s.reasoning_tokens,0)::numeric)
        THEN false
      WHEN s.total_tokens::numeric IN (
        s.input_tokens::numeric+s.cache_read_tokens::numeric+s.cache_write_tokens::numeric+s.output_tokens::numeric,
        s.input_tokens::numeric+s.cache_read_tokens::numeric+s.cache_write_tokens::numeric+s.output_tokens::numeric+coalesce(s.reasoning_tokens,0)::numeric)
        THEN true
      ELSE false
      END AS separate_cache
  ) shape
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN s.token_quality='complete' OR s.api_type IN ('responses','responses-compact') THEN s.input_tokens::numeric
      WHEN s.api_type='messages' OR shape.separate_cache
        THEN s.input_tokens::numeric+s.cache_read_tokens::numeric+s.cache_write_tokens::numeric
      ELSE s.input_tokens::numeric END AS context_input
  ) context
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN s.token_quality='complete' OR s.api_type IN ('responses','responses-compact','messages') THEN s.output_tokens::numeric
      WHEN s.total_tokens::numeric=context.context_input+s.output_tokens::numeric+coalesce(s.reasoning_tokens,0)::numeric
        OR s.output_tokens::numeric < s.reasoning_tokens::numeric
        THEN s.output_tokens::numeric+coalesce(s.reasoning_tokens,0)::numeric
      ELSE s.output_tokens::numeric END AS output_total
  ) output`;
