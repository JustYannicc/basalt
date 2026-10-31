import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";

export async function homeMetadataFixture(db: HistoryDatabase) {
  // Synthetic Home metadata columns only. No fixture prompts, auth blobs or raw keys exist.
  await db.query(`CREATE TABLE usage (
    id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL,request_id text,auth_index text,provider text,
    model text,endpoint text,event_type text,service_tier text,
    input_tokens bigint DEFAULT 100,output_tokens bigint DEFAULT 10,reasoning_tokens bigint DEFAULT 3,
    cached_tokens bigint DEFAULT 20,cache_read_tokens bigint DEFAULT 20,cache_read_tokens_present boolean DEFAULT true,
    cache_creation_tokens bigint DEFAULT 0,total_tokens bigint DEFAULT 110,token_accounting_quality text DEFAULT 'complete',
    token_accounting_version int DEFAULT 2,accounting_input_tokens bigint DEFAULT 100,accounting_output_tokens bigint DEFAULT 10,
    accounting_cache_read_tokens bigint DEFAULT 20,accounting_cache_write_tokens bigint DEFAULT 0,
    accounting_reasoning_tokens bigint DEFAULT 3,accounting_total_tokens bigint DEFAULT 110,
    latency_ms bigint DEFAULT 100,failed boolean DEFAULT false,fail_status_code int DEFAULT 0,
    upstream_status_code int DEFAULT 200,api_key text)`);
  await db.query(`CREATE TABLE billing_charge (id text,usage_id bigint,amount numeric,matched_price_rule text,
    price_snapshot jsonb,api_key_id bigint,user_id bigint)`);
  await db.query("CREATE TABLE api_key (id bigint,diagnostic_fingerprint text,user_id bigint)");
  await db.query('CREATE TABLE "user" (id bigint,username text)');
  await db.query("CREATE TABLE home_data_migration (name text PRIMARY KEY,completed boolean NOT NULL)");
  await db.query("INSERT INTO home_data_migration VALUES ('diagnostics_metadata_only_v1_1_6',true)");
}
