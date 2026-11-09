import { DriveError, type TransactionStorage } from "./shared/index.ts";
import { QuotaExceeded, type QuotaLimits } from "./quota-limits.ts";

/** Reserve a whole upload before storing parts so concurrent uploads can still finish. */
export function uploadBudget(
  storage: TransactionStorage,
  limits: QuotaLimits,
  stored: () => number,
) {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_upload_budget(prefix TEXT PRIMARY KEY, manifest TEXT NOT NULL, fingerprint TEXT NOT NULL, allowance INTEGER NOT NULL, remaining INTEGER NOT NULL, closed INTEGER NOT NULL)",
  );
  const remaining = () =>
    Number(
      [...sql.exec("SELECT COALESCE(SUM(remaining),0) bytes FROM vault_upload_budget")][0]?.bytes ??
        0,
    );
  return {
    remaining,
    reserve(input: { prefix: string; manifest: string; fingerprint: string; bytes: number }) {
      storage.transactionSync(() => {
        const prior = [
          ...sql.exec(
            "SELECT fingerprint,allowance FROM vault_upload_budget WHERE prefix=?",
            input.prefix,
          ),
        ][0];
        if (prior) {
          if (prior.fingerprint !== input.fingerprint || prior.allowance !== input.bytes)
            throw new DriveError("invalid", "Upload operation has a different reservation");
          return;
        }
        const used = stored() + remaining();
        if (used + input.bytes > limits.retainedBytes)
          throw new QuotaExceeded("retainedBytes", used, limits.retainedBytes);
        sql.exec(
          "INSERT INTO vault_upload_budget VALUES(?,?,?,?,?,0)",
          input.prefix,
          input.manifest,
          input.fingerprint,
          input.bytes,
          input.bytes,
        );
      });
    },
    draw(key: string, bytes: number) {
      const rows = [
        ...sql.exec(
          "SELECT prefix,remaining,closed FROM vault_upload_budget WHERE substr(?,1,length(prefix))=prefix OR manifest=? ORDER BY closed ASC",
          key,
          key,
        ),
      ];
      const lease = rows.find((row) => row.closed === 0);
      if (!lease) return false;
      if (typeof lease.prefix !== "string")
        throw new DriveError("integrity", "Invalid upload reservation prefix");
      if (typeof lease.remaining !== "number" || lease.remaining < bytes)
        throw new DriveError("capacity", "Upload exceeded its reserved byte envelope");
      sql.exec(
        "UPDATE vault_upload_budget SET remaining=remaining-? WHERE prefix=?",
        bytes,
        lease.prefix!,
      );
      return true;
    },
    close(prefix: string) {
      sql.exec("UPDATE vault_upload_budget SET remaining=0,closed=1 WHERE prefix=?", prefix);
    },
  };
}
