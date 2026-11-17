import { poolGroupPrefix } from "../pool-group.ts";

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
