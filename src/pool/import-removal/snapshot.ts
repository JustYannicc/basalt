import { Schema } from "effect";
import {
  canonical,
  sha256,
} from "../../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import type { HistoryDatabase } from "../model-history/schema.ts";
import { poolGroupPrefix } from "../pool-group.ts";
import { RemovalRefused, type RemovalSelection } from "./contract.ts";

const Credential = Schema.Struct({
  row: Schema.String,
  id: Schema.String,
  uuid: Schema.String,
  provider: Schema.String,
  disabled: Schema.Boolean,
  deleted: Schema.Boolean,
});
const Membership = Schema.Struct({
  row: Schema.String,
  id: Schema.String,
  pool: Schema.String,
  credential: Schema.String,
  channel: Schema.NullOr(Schema.String),
  deleted: Schema.Boolean,
});
const Retained = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  deleted: Schema.Boolean,
  sha256: Schema.String,
});
export interface RemovalSnapshot {
  credentials: (typeof Credential.Type)[];
  memberships: (typeof Membership.Type)[];
  retain: { id: string; provider: string; sha256: string };
  database: string;
}

/** Full-row JSON stays text so bigint and decimal values survive backup without JS rounding. */
export async function removalSnapshot(
  db: HistoryDatabase,
  selection: RemovalSelection,
): Promise<RemovalSnapshot> {
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '3s'");
    await db.query("SET LOCAL lock_timeout = '500ms'");
    const ids = selection.remove.map((row) => row.id);
    const credentials = Schema.decodeUnknownSync(Schema.Array(Credential))(
      (
        await db.query(
          `SELECT to_jsonb(a)::text AS row, uuid, id, provider, disabled, deleted_at IS NOT NULL AS deleted
       FROM auth a WHERE uuid = ANY($1::text[]) ORDER BY uuid`,
          [ids],
        )
      ).rows,
    );
    if (credentials.length !== ids.length) throw new RemovalRefused();
    for (const expected of selection.remove) {
      const actual = credentials.find((row) => row.uuid === expected.id);
      if (!actual || actual.id !== expected.id || actual.provider !== expected.provider)
        throw new RemovalRefused();
    }
    const memberships = Schema.decodeUnknownSync(Schema.Array(Membership))(
      (
        await db.query(
          `SELECT to_jsonb(m)::text AS row, m.id::text AS id, m.channel_group_id::text AS pool,
       m.auth_id AS credential, g.channel_name AS channel, m.deleted_at IS NOT NULL AS deleted
       FROM channel_group_detail m LEFT JOIN channel_group g ON g.id = m.channel_group_id
       WHERE m.auth_id = ANY($1::text[]) ORDER BY m.id LIMIT 101`,
          [ids],
        )
      ).rows,
    );
    if (
      memberships.length > 100 ||
      memberships.some((row) => row.channel !== `${poolGroupPrefix}${selection.pool}`)
    )
      throw new RemovalRefused();
    const retained = Schema.decodeUnknownSync(Schema.Array(Retained))(
      (
        await db.query(
          `SELECT id, provider, deleted_at IS NOT NULL AS deleted,
       encode(sha256(convert_to(to_jsonb(a)::text, 'UTF8')), 'hex') AS sha256
       FROM auth a WHERE uuid = $1`,
          [selection.retain.id],
        )
      ).rows,
    );
    const retain = retained[0];
    if (
      retained.length !== 1 ||
      !retain ||
      retain.id !== selection.retain.id ||
      retain.provider !== selection.retain.provider ||
      retain.deleted ||
      !/^[a-f0-9]{64}$/.test(retain.sha256)
    )
      throw new RemovalRefused();
    const retainedMembership = Schema.decodeUnknownSync(
      Schema.Struct({ sha256: Schema.String, active: Schema.String }),
    )(
      (
        await db.query(
          `SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text, '[]'), 'UTF8')), 'hex') AS sha256,
       count(*) FILTER (WHERE m.deleted_at IS NULL AND g.deleted_at IS NULL AND g.channel_name = $2)::text AS active
       FROM channel_group_detail m LEFT JOIN channel_group g ON g.id = m.channel_group_id WHERE m.auth_id = $1`,
          [selection.retain.id, `${poolGroupPrefix}${selection.pool}`],
        )
      ).rows[0],
    );
    if (retainedMembership.active === "0") throw new RemovalRefused();
    const identity = (
      await db.query(
        `SELECT current_database() AS database, oid::text AS oid, current_user AS role
       FROM pg_database WHERE datname = current_database()`,
      )
    ).rows[0];
    if (!identity) throw new RemovalRefused();
    const snapshot = {
      credentials: [...credentials],
      memberships: [...memberships],
      retain: {
        id: retain.id,
        provider: retain.provider,
        sha256: sha256(
          canonical({ credential: retain.sha256, memberships: retainedMembership.sha256 }),
        ),
      },
      database: sha256(canonical(identity)),
    };
    if (Buffer.byteLength(canonical(snapshot)) > 1_000_000) throw new RemovalRefused();
    await db.query("COMMIT");
    return snapshot;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export function removalProjection(snapshot: RemovalSnapshot) {
  return {
    credentials: snapshot.credentials.map(({ row, uuid: _uuid, ...metadata }) => ({
      ...metadata,
      sha256: sha256(row),
    })),
    memberships: snapshot.memberships.map(({ row, ...metadata }) => ({
      ...metadata,
      sha256: sha256(row),
    })),
    retain: snapshot.retain,
  };
}

export function removalComplete(snapshot: RemovalSnapshot, retainedSha256: string) {
  return (
    snapshot.credentials.every((row) => row.deleted) &&
    snapshot.memberships.every((row) => row.deleted) &&
    snapshot.retain.sha256 === retainedSha256
  );
}
