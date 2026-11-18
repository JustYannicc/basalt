import { poolGroupPrefix } from "../pool-group.ts";
import { groupPattern as mappedGroup, userPattern } from "./change-schema.ts";

const poolStart = poolGroupPrefix.length + 1;
const groupPattern = `'${`^${poolGroupPrefix}app_.{1,252}$`.replaceAll("'", "''")}'`;

export const historyRowSchemaVersion = "model_request_history_v11_indexed_row_invalidation";

export const historyRowStatements = [
  // textsend is immutable and byte-identical to convert_to(..., 'UTF8') only in a UTF8 database.
  `DO $$ BEGIN
    IF current_setting('server_encoding') <> 'UTF8' THEN
      RAISE EXCEPTION 'History hash indexes require server_encoding UTF8, found %',
        current_setting('server_encoding') USING ERRCODE = '0A000';
    END IF;
  END $$`,
  `CREATE FUNCTION basalt_pool_history_hash(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT AS $$
      SELECT left(encode(sha256(textsend(value)),'hex'),16)
    $$`,
  `DO $$ BEGIN IF to_regclass('channel_group') IS NOT NULL THEN
    CREATE INDEX basalt_pool_group_history_hash ON channel_group
      ((basalt_pool_history_hash(substring(channel_name FROM ${poolStart})))) INCLUDE(channel_name)
      WHERE channel_name ~ ${groupPattern};
  END IF; END $$`,
  `CREATE INDEX basalt_pool_heads_history_hash ON basalt_pool_change_heads
    ((basalt_pool_history_hash(pool))) INCLUDE(pool)`,
  // Keep the two STABLE queries at each legacy row-trigger call. Caching targets across rows
  // changes concurrent mapping visibility. Trigger definitions and their UPDATE/DELETE paths stay intact.
  `CREATE OR REPLACE FUNCTION basalt_pool_change_targets(group_ids bigint[], auth_ids text[], pool_hashes text[], all_pools boolean DEFAULT false)
    RETURNS TABLE(pool text) LANGUAGE plpgsql STABLE AS $$ BEGIN
      IF cardinality(group_ids)=0 AND cardinality(auth_ids)=0 AND NOT all_pools THEN
        IF to_regclass('channel_group') IS NOT NULL THEN
          RETURN QUERY SELECT DISTINCT substring(g.channel_name FROM ${poolStart})
            FROM channel_group g WHERE g.channel_name ~ ${groupPattern}
              AND basalt_pool_history_hash(substring(g.channel_name FROM ${poolStart}))=ANY(pool_hashes);
        END IF;
        RETURN QUERY SELECT h.pool::text FROM basalt_pool_change_heads h
          WHERE basalt_pool_history_hash(h.pool)=ANY(pool_hashes);
        RETURN;
      END IF;
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
];

export const historyChangeOnceVersion =
  "model_request_history_v12_change_feed_once_per_transaction";

const memoName = "'basalt.pool_change_memo'";
const pools = `substring(g.channel_name FROM ${poolStart})`;

/** Resolves (hash, pool) rows once, bumps each pool once in name order and keeps the matched hashes. */
const record = (targets: string) => `WITH t AS MATERIALIZED (${targets}),
        bumped AS MATERIALIZED (SELECT basalt_pool_change(d.pool,change_topic)
          FROM (SELECT DISTINCT t.pool FROM t WHERE t.pool IS NOT NULL ORDER BY t.pool) d)
      SELECT array_agg(DISTINCT t.hash) FILTER (WHERE t.hash IS NOT NULL) INTO found_hashes
        FROM t WHERE (SELECT count(*) FROM bumped) >= 0;`;

// Same pools as basalt_pool_change_targets' hash-only branch; the join keeps the matched hash.
const byHash = (hashes: string, groups: boolean) =>
  record(`WITH h AS (SELECT DISTINCT v FROM (${hashes}) s(v) WHERE v IS NOT NULL
        AND position(';'||change_topic||':'||v||';' IN memo)=0)
      ${groups ? `SELECT h.v AS hash,${pools}::text AS pool FROM h JOIN channel_group g ON g.channel_name ~ ${mappedGroup} AND basalt_pool_history_hash(${pools})=h.v UNION ALL ` : ""}SELECT h.v,p.pool::text FROM h JOIN basalt_pool_change_heads p ON basalt_pool_history_hash(p.pool)=h.v`);
const byGroup = (condition: string) =>
  record(`SELECT NULL::text AS hash,${pools}::text AS pool FROM channel_group g
      WHERE g.channel_name ~ ${mappedGroup} AND (${condition})`);
const users = `SELECT substring(u.username FROM ${userPattern}) FROM "user" u
        WHERE u.id IN ((before_row->>'user_id')::bigint,(after_row->>'user_id')::bigint)`;
const credentialIds = `CASE WHEN mode='auth' THEN ARRAY[before_row->>'uuid',before_row->>'id',before_row->>'index',
          after_row->>'uuid',after_row->>'id',after_row->>'index']
        ELSE ARRAY[before_row->>'credential_id',after_row->>'credential_id'] END`;

/**
 * Replaces function bodies only: triggers, indexes and the producer stay, so no table lock is taken.
 * Each row still resolves at its own trigger snapshot. A resolver run once at statement end leaves a
 * reader that registers after a mid-statement mapping delete with a stale count and no later change
 * (the delete case in history-insert-races.test.ts). What happens once per transaction is the bump:
 * with the journal active, a row whose hash already bumped its pool in this transaction would only
 * repeat no-op inserts, so it skips them. The memo is transaction-local and rolls back with them.
 */
export const historyChangeOnceStatements = [
  // textsend is STABLE, so the SQL body is never inlined and every heads index write ran it as a
  // statement. A PL/pgSQL RETURN is one simple expression with the same bytes and result.
  `CREATE OR REPLACE FUNCTION basalt_pool_history_hash(value text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT AS $$
      BEGIN RETURN left(encode(sha256(textsend(value)),'hex'),16); END
    $$`,
  `CREATE OR REPLACE FUNCTION basalt_pool_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE before_row jsonb := '{}'::jsonb; after_row jsonb := '{}'::jsonb;
      mode text := TG_ARGV[0]; change_topic text := TG_ARGV[2]; field text; changed boolean := false;
      journal boolean := false; memo text := ''; own text; item text; hashes text[]; pending text[] := '{}';
      found_hashes text[]; targets text[];
    BEGIN
      IF TG_OP <> 'INSERT' THEN before_row := to_jsonb(OLD); END IF;
      IF TG_OP <> 'DELETE' THEN after_row := to_jsonb(NEW); END IF;
      -- Settings rows other than billing.settings never reach a pool answer, before or after.
      IF mode='settings' AND COALESCE(before_row->>'key','') <> 'billing.settings'
        AND COALESCE(after_row->>'key','') <> 'billing.settings' THEN
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END IF;
      IF TG_OP='UPDATE' THEN
        -- Field-by-field equality is basalt_pool_change_fields equality, without its two queries.
        FOREACH field IN ARRAY string_to_array(TG_ARGV[1],',') LOOP
          IF before_row->field IS DISTINCT FROM after_row->field THEN changed := true; EXIT; END IF;
        END LOOP;
        -- Equal raw values have equal readings, so only a raw difference needs the reading.
        IF changed AND mode='auth' THEN
          before_row := jsonb_set(before_row,'{auth_json}',basalt_pool_auth_reading(before_row->'auth_json'));
          after_row := jsonb_set(after_row,'{auth_json}',basalt_pool_auth_reading(after_row->'auth_json'));
        ELSIF changed AND mode='settings' THEN
          IF before_row->>'key'='billing.settings' THEN
            before_row := jsonb_set(before_row,'{value}',basalt_pool_settings_reading(OLD.value));
          END IF;
          IF after_row->>'key'='billing.settings' THEN
            after_row := jsonb_set(after_row,'{value}',basalt_pool_settings_reading(NEW.value));
          END IF;
        END IF;
        IF changed AND mode IN ('auth','settings') THEN
          changed := false;
          FOREACH field IN ARRAY string_to_array(TG_ARGV[1],',') LOOP
            IF before_row->field IS DISTINCT FROM after_row->field THEN changed := true; EXIT; END IF;
          END LOOP;
        END IF;
        IF NOT changed THEN RETURN NEW; END IF;
      END IF;
      IF mode IN ('history','user','key','charge') THEN
        -- Before activation every call bumps a revision, so nothing may be skipped there.
        journal := to_regprocedure('basalt_pool_flush_changes()') IS NOT NULL;
        IF journal THEN
          own := txid_current()::text || ';';
          memo := COALESCE(current_setting(${memoName},true),'');
          IF left(memo,length(own)) <> own THEN memo := own; END IF;
        END IF;
      END IF;
      IF mode IN ('history','user') THEN
        hashes := CASE WHEN mode='history' THEN ARRAY[before_row->>'pool',after_row->>'pool']
          ELSE ARRAY[substring(before_row->>'username' FROM ${userPattern}),
            substring(after_row->>'username' FROM ${userPattern})] END;
        FOREACH item IN ARRAY hashes LOOP
          IF item IS NOT NULL AND position(';'||change_topic||':'||item||';' IN memo)=0 THEN
            pending := pending || item;
          END IF;
        END LOOP;
        IF cardinality(pending)=0 THEN
          IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
        END IF;
        IF to_regclass('channel_group') IS NOT NULL THEN
          ${byHash("SELECT unnest(pending)", true)}
        ELSE
          ${byHash("SELECT unnest(pending)", false)}
        END IF;
      ELSIF mode IN ('key','charge') THEN
        IF to_regclass('channel_group') IS NOT NULL THEN
          ${byHash(users, true)}
        ELSE
          ${byHash(users, false)}
        END IF;
      ELSIF mode='group' THEN
        targets := ARRAY[substring(before_row->>'channel_name' FROM ${poolStart}),substring(after_row->>'channel_name' FROM ${poolStart})];
        IF COALESCE(before_row->>'channel_name','') !~ ${mappedGroup} THEN targets[1] := NULL; END IF;
        IF COALESCE(after_row->>'channel_name','') !~ ${mappedGroup} THEN targets[2] := NULL; END IF;
        IF targets[1] IS NOT NULL OR targets[2] IS NOT NULL THEN
          ${record("SELECT NULL::text AS hash,v AS pool FROM unnest(targets) v")}
        END IF;
      ELSIF to_regclass('channel_group') IS NULL THEN
        NULL;
      ELSIF mode='membership' THEN
        ${byGroup("g.id=ANY(ARRAY[(before_row->>'channel_group_id')::bigint,(after_row->>'channel_group_id')::bigint])")}
      ELSIF mode IN ('credential','auth') THEN
        ${byGroup(`g.id IN (SELECT d.channel_group_id FROM channel_group_detail d
          WHERE d.auth_id=ANY(${credentialIds}) AND d.deleted_at IS NULL)`)}
      ELSE
        ${byGroup("g.deleted_at IS NULL AND NOT g.disabled")}
      END IF;
      IF journal AND found_hashes IS NOT NULL THEN
        FOREACH item IN ARRAY found_hashes LOOP
          IF item ~ '^[a-f0-9]{16}$' AND position(';'||change_topic||':'||item||';' IN memo)=0 THEN
            memo := memo || change_topic || ':' || item || ';';
          END IF;
        END LOOP;
        memo := set_config(${memoName},memo,true);
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$`,
];
