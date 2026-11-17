export const historyBulkInvalidationVersion = "model_request_history_v12_bulk_invalidation";

// Frozen with the migration: a new column needs a new function version, not an import from store.ts.
// Naming the columns keeps ingested_at on its default instead of a populated NULL.
export const historyBulkColumns = `id, source, source_record, timestamp, timestamp_exact, pool, person, account,
  client_key, request_id, provider, model, endpoint, api_type, service_tier, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
  token_quality, latency_ms, failed, status_code, cost, currency, cost_basis, price_version,
  original_price_rule, price_snapshot, attribution, app_id, requirement`;

export const historyBulkInvalidationStatements = [
  `CREATE OR REPLACE TRIGGER basalt_pool_change_write AFTER UPDATE ON basalt_model_requests
    FOR EACH ROW EXECUTE FUNCTION basalt_pool_record_change('history','pool','pool-usage')`,
  // The condition avoids invoking the row function at all during this pool's bulk INSERT.
  // PostgreSQL clones parent row triggers onto every partition, including direct inserts.
  `CREATE TRIGGER basalt_pool_history_insert AFTER INSERT ON basalt_model_requests FOR EACH ROW
    WHEN (COALESCE(current_setting('basalt.history_bulk_pool',true),'') IS DISTINCT FROM NEW.pool)
    EXECUTE FUNCTION basalt_pool_record_change('history','pool','pool-usage')`,
  // Keep bypass and invalidation inseparable. The authenticated frozen job supplies the raw
  // pool ID, so concurrent mapping removal cannot lose the post-commit cache invalidation.
  `CREATE FUNCTION basalt_model_history_bulk_insert(pool_id text, records jsonb) RETURNS SETOF text
    LANGUAGE plpgsql AS $$ DECLARE previous text; expected text; BEGIN
      IF pool_id IS NULL OR pool_id !~ '^app_.{1,252}$' THEN
        RAISE EXCEPTION 'Invalid bulk history pool' USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(records) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Bulk history records must be an array' USING ERRCODE = '22023';
      END IF;
      IF jsonb_array_length(records)>5000 THEN
        RAISE EXCEPTION 'Bulk history exceeds 5000 rows' USING ERRCODE = '22023';
      END IF;
      expected := basalt_pool_history_hash(pool_id);
      -- Stops at the first missing or foreign pool without materializing the array.
      IF jsonb_path_exists(records,'$[*] ? (!exists(@.pool ? (@ == $p)))',
        jsonb_build_object('p',expected)) THEN
        RAISE EXCEPTION 'Bulk history row pool differs from chunk pool' USING ERRCODE = '22023';
      END IF;
      previous := current_setting('basalt.history_bulk_pool',true);
      PERFORM set_config('basalt.history_bulk_pool',expected,true);
      RETURN QUERY INSERT INTO basalt_model_requests (${historyBulkColumns})
        SELECT ${historyBulkColumns} FROM jsonb_populate_recordset(NULL::basalt_model_requests,records)
        ORDER BY id ON CONFLICT(id) DO NOTHING RETURNING basalt_model_requests.id::text;
      PERFORM set_config('basalt.history_bulk_pool',COALESCE(previous,''),true);
      PERFORM basalt_pool_change(pool_id,'pool-usage');
    END $$`,
];
