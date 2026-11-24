import { brand } from "../../../brand.ts";

/** The username pattern of one history pool's backend users, by its 16-hex history id. */
export function poolUsernamePattern(poolHash: string) {
  const setupId = brand.setup.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${setupId}-[0-9a-f]{64}-${poolHash}$`;
}

/** A Home usage row's hour, in UTC: the capture check and the stored count bucket by it alike. */
export const usageHour = "date_trunc('hour',u.timestamp AT TIME ZONE 'UTC')";

/**
 * The Home usage rows `u` of one pool's users whose time matches `range`. Every reader of a pool's
 * usage population goes through this: the per-row capture check and the stored hour count consider
 * exactly the same rows, so a count can stand in for that check. The range is a predicate on
 * u.timestamp, so Home's usage time index serves it.
 */
export const poolUsageRows = (pattern: string, range: string) => `usage u
    LEFT JOIN billing_charge c ON c.usage_id=u.id
    LEFT JOIN api_key k ON k.diagnostic_fingerprint=u.api_key AND u.api_key ~ '^sha256:[0-9a-f]{64}$'
    LEFT JOIN "user" a ON a.id=COALESCE(c.user_id,k.user_id)
    WHERE a.username ~ ${pattern} AND ${range}`;

/**
 * No request of this pool, its Home source and this usage row's record. Every writer keys a request
 * by the digest of its source and record, so the lookup is one partition's primary key instead of a
 * probe of each partition by record. The pool, source and record must still match: a row keyed
 * otherwise reads as missing, never as captured. The record is compared as text, so the record
 * index, which names no partition, can never serve the lookup in the id's place.
 */
export const uncaptured = (pool: string, source: string) => `NOT EXISTS (
        SELECT 1 FROM basalt_model_requests r
        WHERE r.id=encode(sha256(convert_to('["'||${source}::text||'","'
            ||encode(sha256(convert_to('["usage","'||u.id::text||'"]','UTF8')),'hex')||'"]','UTF8')),'hex')::character(64)
          AND r.pool=${pool} AND r.source=${source}::character(64)
          AND r.source_record::text=encode(sha256(convert_to('["usage","'||u.id::text||'"]','UTF8')),'hex')
      )`;
