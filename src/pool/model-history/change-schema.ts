import { brand } from "../../../brand.ts";
import { poolGroupPrefix } from "../pool-group.ts";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const appPattern = "^app_.{1,252}$";
const groupPattern = literal(`^${poolGroupPrefix}app_.{1,252}$`);
const poolStart = poolGroupPrefix.length + 1;
const userPattern = literal(
  `^${brand.setup.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-f0-9]{64}-([a-f0-9]{16})$`,
);

// Only these projections affect pool answers. In particular auth token refreshes and
// quota probe leases must not turn unchanged upkeep into a stream of invalidations.
const watched = [
  ["basalt_model_requests", "history", "pool", "pool-usage"],
  ["basalt_model_traffic", "history", "pool,source,client_key,purpose,evidence", "pool-usage"],
  [
    "channel_group",
    "group",
    "id,channel_name,disabled,deleted_at,usage_credit_policy,account_selection_policy",
  ],
  ["channel_group_detail", "membership", "channel_group_id,auth_id,deleted_at"],
  [
    "auth",
    "auth",
    "uuid,id,index,provider,label,prefix,status,disabled,unavailable,base_url,compat_name,provider_key,models_hash,quota_identity_version,next_retry_after,deleted_at,auth_json",
  ],
  [
    "quota_snapshot",
    "credential",
    "credential_id,quota_status,collection_status,source,observed_at,expires_at,last_attempt_at,last_success_at,next_probe_at,consecutive_failures,error_code,error_message,error_retryable,error_status_code,plan_name,plan_premium,reset_credits,usage_credits",
  ],
  [
    "quota_window",
    "credential",
    "credential_id,window_id,priority,label,scope,scope_id,mode,status,unit,currency,used,remaining,limit_value,used_ratio,remaining_ratio,is_unlimited,reset_at,window_seconds,period_unit,period_value,source,observed_at,expires_at",
  ],
  ["credential_concurrency_policies", "credential", "credential_id,max_in_flight"],
  ["credential_concurrency_model_policies", "credential", "credential_id,model,max_in_flight"],
  [
    "user",
    "user",
    "id,username,credits,credits_unlimited,timezone,limit_5h_credits,limit_1d_credits,limit_7d_credits,limit_30d_credits,window_mode_5h,window_mode_1d,window_mode_7d,window_mode_30d,week_reset_day,week_reset_hour,period_window_start_5h,period_window_start_1d,period_window_start_7d,period_window_start_30d,usage_epoch_5h,usage_epoch_1d,usage_epoch_7d,usage_epoch_30d,deleted_at",
  ],
  ["api_key", "key", "id,user_id,channels,model_groups,display_name,deleted_at"],
  ["billing_charge", "charge", "user_id,api_key_id,amount,usage_id"],
  [
    "billing_model_price",
    "global",
    "id,provider,model,service_tier,min_input_tokens,input_price_per_million,output_price_per_million,cache_read_price_per_million,cache_write_price_per_million,request_price,source,enabled,note,deleted_at",
  ],
  ["config", "global", "key,value"],
  ["kv_store", "settings", "key,value"],
  ["model_group", "global", "id,group_name,disabled,deleted_at"],
  ["model_group_detail", "global", "model_group_id,model_id,channels,deleted_at"],
  ["lifecycle_config", "global", "node_heartbeat_timeout,payload"],
] as const;

export const historyChangeStatements = [
  `CREATE TABLE IF NOT EXISTS basalt_pool_change_heads (
    pool varchar(256) NOT NULL CHECK (pool ~ ${literal(appPattern)}),
    topic text NOT NULL CHECK (topic IN ('pool-readings','pool-usage')),
    revision bigint NOT NULL CHECK (revision >= 0), PRIMARY KEY (pool,topic))`,
  `CREATE TABLE IF NOT EXISTS basalt_pool_change_pending (
    pool varchar(256) NOT NULL, topic text NOT NULL, revision bigint NOT NULL CHECK (revision > 0),
    queued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (pool,topic),
    FOREIGN KEY (pool,topic) REFERENCES basalt_pool_change_heads(pool,topic))`,
  `CREATE OR REPLACE FUNCTION basalt_pool_change(pool_id text, change_topic text) RETURNS void
    LANGUAGE plpgsql AS $$ DECLARE next_revision bigint; BEGIN
      IF pool_id IS NULL OR pool_id !~ ${literal(appPattern)} THEN RETURN; END IF;
      INSERT INTO basalt_pool_change_heads AS h(pool,topic,revision) VALUES(pool_id,change_topic,1)
        ON CONFLICT(pool,topic) DO UPDATE SET revision=h.revision+1 RETURNING revision INTO next_revision;
      INSERT INTO basalt_pool_change_pending AS p(pool,topic,revision) VALUES(pool_id,change_topic,next_revision)
        ON CONFLICT(pool,topic) DO UPDATE SET revision=GREATEST(p.revision,EXCLUDED.revision);
    END $$`,
  // Home-less history import fixtures remain supported. Production installs these triggers
  // after Home's schema gate. Mapping reads groups and indexed membership, never history.
  `CREATE OR REPLACE FUNCTION basalt_pool_change_targets(group_ids bigint[], auth_ids text[], pool_hashes text[], all_pools boolean DEFAULT false)
    RETURNS TABLE(pool text) LANGUAGE plpgsql STABLE AS $$ BEGIN
      IF to_regclass('channel_group') IS NOT NULL THEN
        RETURN QUERY SELECT DISTINCT substring(g.channel_name FROM ${poolStart})
          FROM channel_group g WHERE g.channel_name ~ ${groupPattern} AND (
            (all_pools AND g.deleted_at IS NULL AND NOT g.disabled)
            OR g.id=ANY(group_ids)
            OR g.id IN (SELECT d.channel_group_id FROM channel_group_detail d
              WHERE d.auth_id=ANY(auth_ids) AND d.deleted_at IS NULL)
            OR left(encode(sha256(convert_to(substring(g.channel_name FROM ${poolStart}),'UTF8')),'hex'),16)=ANY(pool_hashes));
      END IF;
      RETURN QUERY SELECT h.pool::text FROM basalt_pool_change_heads h
        WHERE left(encode(sha256(convert_to(h.pool,'UTF8')),'hex'),16)=ANY(pool_hashes);
    END $$`,
  `CREATE OR REPLACE FUNCTION basalt_pool_change_fields(value jsonb, fields text[]) RETURNS jsonb
    LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb)
      FROM jsonb_each(CASE WHEN jsonb_typeof($1)='object' THEN $1 ELSE '{}'::jsonb END) f
      WHERE f.key=ANY($2) $$`,
  `CREATE OR REPLACE FUNCTION basalt_pool_settings_reading(value bytea) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN convert_from(value,'UTF8')::jsonb;
      EXCEPTION WHEN data_exception THEN RETURN to_jsonb(value); END $$`,
  `CREATE OR REPLACE FUNCTION basalt_pool_deadline(value text) RETURNS timestamptz
    LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN value::timestamptz;
      EXCEPTION WHEN data_exception THEN RETURN NULL; END $$`,
  // These are deadlines on the retained reading, not fresh observations. Caps exposed by
  // the pool UI are UTC calendar weeks; other Home cap modes stay outside this deadline.
  `CREATE OR REPLACE FUNCTION basalt_pool_change_deadline(pool_id text) RETURNS timestamptz
    LANGUAGE plpgsql STABLE AS $$ DECLARE quota_deadline timestamptz; cap_deadline timestamptz;
      instant timestamptz := statement_timestamp();
    BEGIN
      IF to_regclass('channel_group') IS NOT NULL AND to_regclass('channel_group_detail') IS NOT NULL
        AND to_regclass('quota_snapshot') IS NOT NULL AND to_regclass('quota_window') IS NOT NULL THEN
        WITH members AS MATERIALIZED (
          SELECT DISTINCT d.auth_id FROM channel_group g JOIN channel_group_detail d ON d.channel_group_id=g.id
          WHERE g.channel_name=${literal(poolGroupPrefix)}||pool_id AND g.deleted_at IS NULL AND d.deleted_at IS NULL
        ), deadlines AS (
          SELECT at FROM members m JOIN quota_snapshot s ON s.credential_id=m.auth_id
            CROSS JOIN LATERAL (VALUES(s.expires_at),(basalt_pool_deadline(s.usage_credits->>'expires_at'))) t(at)
          UNION ALL
          SELECT basalt_pool_deadline(credit->>'expires_at') FROM members m JOIN quota_snapshot s ON s.credential_id=m.auth_id
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.reset_credits->'credits')='array'
              THEN s.reset_credits->'credits' ELSE '[]'::jsonb END) credit
            WHERE credit->>'status'='available' AND credit->>'remaining' IS DISTINCT FROM '0'
          UNION ALL
          SELECT at FROM members m JOIN quota_window w ON w.credential_id=m.auth_id
            CROSS JOIN LATERAL (VALUES(w.expires_at),(CASE WHEN to_jsonb(w)->>'is_unlimited' IS DISTINCT FROM 'true'
              THEN w.reset_at END)) t(at)
        ) SELECT min(at) INTO quota_deadline FROM deadlines WHERE at>instant AND isfinite(at);
      END IF;
      IF to_regclass('user') IS NOT NULL THEN
        SELECT min((date_trunc('week',instant AT TIME ZONE 'UTC')+interval '7 days') AT TIME ZONE 'UTC')
          INTO cap_deadline FROM "user" u
          WHERE substring(u.username FROM ${userPattern})=left(encode(sha256(convert_to(pool_id,'UTF8')),'hex'),16)
            AND to_jsonb(u)->>'deleted_at' IS NULL AND to_jsonb(u)->>'limit_7d_credits' IS NOT NULL
            AND to_jsonb(u)->>'window_mode_7d'='calendar' AND to_jsonb(u)->>'timezone'='UTC'
            AND to_jsonb(u)->>'week_reset_day'='1' AND to_jsonb(u)->>'week_reset_hour'='0';
      END IF;
      RETURN LEAST(quota_deadline,cap_deadline);
    END $$`,
  // Stored auth includes credentials and bookkeeping. Compare only its visible state;
  // model-state updated_at changes on otherwise identical reports are bookkeeping too.
  `CREATE OR REPLACE FUNCTION basalt_pool_auth_reading(value jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE AS $$ SELECT
      basalt_pool_change_fields($1,ARRAY['status_message','quota','last_error','last_refresh_error','next_retry_after'])
      || jsonb_build_object('identity',basalt_pool_change_fields(COALESCE($1->'metadata','{}'::jsonb),
          ARRAY['email','name','account_id','organization_id','plan_type','type','disabled','excluded_models','models',
            'home_config_models','weight','request_retry','disable_cooling']),
        'attributes',basalt_pool_change_fields(COALESCE($1->'attributes','{}'::jsonb),
          ARRAY['excluded_models','models','priority','weight','disable_cooling']),
        'models',COALESCE((SELECT jsonb_object_agg(m.key,CASE WHEN jsonb_typeof(m.value)='object'
            THEN m.value-'updated_at' ELSE m.value END)
          FROM jsonb_each(CASE WHEN jsonb_typeof($1->'model_states')='object'
            THEN $1->'model_states' ELSE '{}'::jsonb END) m),'{}'::jsonb)) $$`,
  `CREATE OR REPLACE FUNCTION basalt_pool_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE before_row jsonb := '{}'::jsonb; after_row jsonb := '{}'::jsonb;
      mode text := TG_ARGV[0]; change_topic text := TG_ARGV[2]; targets text[]; item text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN before_row := to_jsonb(OLD); END IF;
      IF TG_OP <> 'DELETE' THEN after_row := to_jsonb(NEW); END IF;
      IF mode='auth' THEN
        before_row := jsonb_set(before_row,'{auth_json}',basalt_pool_auth_reading(before_row->'auth_json'));
        after_row := jsonb_set(after_row,'{auth_json}',basalt_pool_auth_reading(after_row->'auth_json'));
      END IF;
      IF mode='settings' THEN
        IF TG_OP <> 'INSERT' AND before_row->>'key'='billing.settings' THEN
          before_row := jsonb_set(before_row,'{value}',basalt_pool_settings_reading(OLD.value));
        END IF;
        IF TG_OP <> 'DELETE' AND after_row->>'key'='billing.settings' THEN
          after_row := jsonb_set(after_row,'{value}',basalt_pool_settings_reading(NEW.value));
        END IF;
      END IF;
      IF TG_OP='UPDATE' AND basalt_pool_change_fields(before_row,string_to_array(TG_ARGV[1],','))
        IS NOT DISTINCT FROM basalt_pool_change_fields(after_row,string_to_array(TG_ARGV[1],',')) THEN RETURN NEW; END IF;
      IF mode='group' THEN
        targets := ARRAY[substring(before_row->>'channel_name' FROM ${poolStart}),substring(after_row->>'channel_name' FROM ${poolStart})];
        IF COALESCE(before_row->>'channel_name','') !~ ${groupPattern} THEN targets[1] := NULL; END IF;
        IF COALESCE(after_row->>'channel_name','') !~ ${groupPattern} THEN targets[2] := NULL; END IF;
      ELSIF mode='membership' THEN
        targets := ARRAY(SELECT pool FROM basalt_pool_change_targets(
          ARRAY[(before_row->>'channel_group_id')::bigint,(after_row->>'channel_group_id')::bigint],ARRAY[]::text[],ARRAY[]::text[]));
      ELSIF mode IN ('credential','auth') THEN
        targets := ARRAY(SELECT pool FROM basalt_pool_change_targets(ARRAY[]::bigint[],
          CASE WHEN mode='auth' THEN ARRAY[before_row->>'uuid',before_row->>'id',before_row->>'index',
            after_row->>'uuid',after_row->>'id',after_row->>'index']
          ELSE ARRAY[before_row->>'credential_id',after_row->>'credential_id'] END,ARRAY[]::text[]));
      ELSIF mode IN ('user','key','charge') THEN
        targets := ARRAY(SELECT pool FROM basalt_pool_change_targets(ARRAY[]::bigint[],ARRAY[]::text[],
          CASE WHEN mode='user' THEN ARRAY[substring(before_row->>'username' FROM ${userPattern}),substring(after_row->>'username' FROM ${userPattern})]
          ELSE ARRAY(SELECT substring(u.username FROM ${userPattern}) FROM "user" u
            WHERE u.id IN ((before_row->>'user_id')::bigint,(after_row->>'user_id')::bigint)) END));
      ELSIF mode='history' THEN
        targets := ARRAY(SELECT pool FROM basalt_pool_change_targets(ARRAY[]::bigint[],ARRAY[]::text[],
          ARRAY[before_row->>'pool',after_row->>'pool']));
      ELSE
        IF mode='settings' AND COALESCE(before_row->>'key','') <> 'billing.settings'
          AND COALESCE(after_row->>'key','') <> 'billing.settings' THEN
          IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
        END IF;
        targets := ARRAY(SELECT pool FROM basalt_pool_change_targets(ARRAY[]::bigint[],ARRAY[]::text[],ARRAY[]::text[],true));
      END IF;
      FOR item IN SELECT DISTINCT value FROM unnest(targets) AS t(value) WHERE value IS NOT NULL ORDER BY value LOOP
        PERFORM basalt_pool_change(item,change_topic);
      END LOOP;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$`,
  ...watched.flatMap(([table, mode, fields, topic = "pool-readings"]) => {
    const invoke = `EXECUTE FUNCTION basalt_pool_record_change(${literal(mode)},${literal(fields)},${literal(topic)})`;
    return [
      `DO $$ BEGIN IF to_regclass('${table}') IS NOT NULL THEN
        EXECUTE ${literal(`CREATE OR REPLACE TRIGGER basalt_pool_change_write AFTER INSERT OR UPDATE ON "${table}" FOR EACH ROW ${invoke}`)};
        EXECUTE ${literal(`CREATE OR REPLACE TRIGGER basalt_pool_change_delete BEFORE DELETE ON "${table}" FOR EACH ROW ${invoke}`)};
      END IF; END $$`,
    ];
  }),
];
