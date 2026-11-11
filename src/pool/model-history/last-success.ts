import { digest } from "../backend-users.ts";
import type { HistoryDatabase } from "./schema.ts";
import { historyObject, identifier, timestamp } from "./record.ts";
import { authorizeSeries, seriesIds } from "./series-input.ts";
import type { SeriesAuthority } from "./series-contract.ts";
import { utcSql } from "./series-query.ts";
import { accountHistoryReferences, importAccountPrefix } from "./import-account-reference.ts";

/** One backwards index lookup per current Home credential, with no historical range scan. */
export async function lastSuccessAt(db: HistoryDatabase, raw: unknown, authority: SeriesAuthority) {
  const input = historyObject(raw),
    pool = identifier(input.pool, true)!;
  const accounts = seriesIds(input.accounts);
  authorizeSeries({ accounts }, authority);
  const bindings = authority.mappingProven
    ? authority.accounts.flatMap((account) =>
        account.account !== null && accounts.includes(account.account)
          ? account.history.flatMap((home) =>
              accountHistoryReferences(home).map((history) => ({
                saved: account.account,
                history,
              })),
            )
          : [],
      )
    : [];
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const rows = bindings.length
      ? (
          await db.query(
            `WITH bindings AS (
        SELECT * FROM jsonb_to_recordset($3::jsonb) AS b(saved text,history text))
      SELECT b.saved,max(latest.timestamp_exact) AS at FROM bindings b
      LEFT JOIN LATERAL (SELECT timestamp_exact,id FROM basalt_model_requests
        WHERE pool=$1 AND account=b.history::character(64)
          AND (source=$2 OR attribution='import-owner' AND left(account, ${importAccountPrefix.length})='${importAccountPrefix}') AND NOT failed
        ORDER BY timestamp DESC,timestamp_exact DESC,id DESC LIMIT 1) latest ON true
      GROUP BY b.saved ORDER BY b.saved`,
            [
              (await digest(pool)).slice(0, 16),
              await digest("home-local-v1"),
              JSON.stringify(bindings),
            ],
          )
        ).rows
      : [];
    const watermark = (
      await db.query(
        `SELECT ${utcSql("updated_at")} AS at
      FROM basalt_model_history_cursor WHERE source=$1`,
        [await digest("home-local-v1")],
      )
    ).rows[0]?.at;
    await db.query("COMMIT");
    return {
      asOf: watermark === undefined || watermark === null ? null : timestamp(String(watermark)),
      mapping: {
        current: true,
        historicalGenerations: "unknown",
        proof: authority.mappingProven ? "proven" : "unavailable",
      },
      accounts: accounts.map((account) => {
        const at = rows.find((row) => row.saved === account)?.at;
        return {
          account,
          lastSuccessAt: at === undefined || at === null ? null : timestamp(String(at)),
        };
      }),
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
