import { DriveError, type TransactionStorage } from "./shared/index.ts";
import { QuotaExceeded, type QuotaLimits } from "./quota-limits.ts";
export { QuotaExceeded, defaultLimits, type QuotaLimits } from "./quota-limits.ts";

/** The account ledger is durable. Cache eviction never touches it. */
export function quotaAccount(storage: TransactionStorage, limits: QuotaLimits) {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_quota(id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, files INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL, reserved_files INTEGER NOT NULL)",
  );
  sql.exec("INSERT OR IGNORE INTO vault_quota VALUES(1,0,0,0,0)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_reservations(id TEXT PRIMARY KEY, operation TEXT NOT NULL, prefix TEXT NOT NULL, fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL, files INTEGER NOT NULL, state TEXT NOT NULL)",
  );
  const status = () => {
    const row = [...sql.exec("SELECT * FROM vault_quota WHERE id=1")][0];
    if (
      !row ||
      ![row.bytes, row.files, row.reserved_bytes, row.reserved_files].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new DriveError("integrity", "Invalid durable quota ledger");
    return {
      currentBytes: Number(row.bytes),
      files: Number(row.files),
      reservedBytes: Number(row.reserved_bytes),
      reservedFiles: Number(row.reserved_files),
    };
  };
  const finish = (id: string, applied: boolean) =>
    storage.transactionSync(() => {
      const row = [...sql.exec("SELECT * FROM vault_reservations WHERE id=?", id)][0];
      if (!row || row.state !== "pending") return;
      if (typeof row.bytes !== "number" || typeof row.files !== "number")
        throw new DriveError("integrity", "Invalid quota reservation");
      sql.exec(
        "UPDATE vault_quota SET bytes=bytes+?,files=files+?,reserved_bytes=reserved_bytes-?,reserved_files=reserved_files-? WHERE id=1",
        applied ? row.bytes : 0,
        applied ? row.files : 0,
        Math.max(0, row.bytes),
        Math.max(0, row.files),
      );
      sql.exec(
        "UPDATE vault_reservations SET state=? WHERE id=?",
        applied ? "applied" : "released",
        id,
      );
    });
  return {
    status,
    finish,
    pending(prefix: string) {
      return [
        ...sql.exec(
          "SELECT id,operation FROM vault_reservations WHERE prefix=? AND state='pending'",
          prefix,
        ),
      ].map((row) => {
        if (typeof row.id !== "string" || typeof row.operation !== "string")
          throw new DriveError("integrity", "Invalid pending quota operation");
        return { id: row.id, operation: row.operation };
      });
    },
    reserve(prefix: string, operation: string, fingerprint: string, bytes: number, files: number) {
      const id = prefix + operation;
      storage.transactionSync(() => {
        const old = [...sql.exec("SELECT * FROM vault_reservations WHERE id=?", id)][0];
        if (old && old.state !== "released") {
          if (old.fingerprint !== fingerprint)
            throw new DriveError("invalid", "A quota operation cannot identify another request");
          return;
        }
        const used = status();
        if (used.currentBytes + used.reservedBytes + Math.max(0, bytes) > limits.currentBytes)
          throw new QuotaExceeded(
            "currentBytes",
            used.currentBytes + used.reservedBytes,
            limits.currentBytes,
          );
        if (used.files + used.reservedFiles + Math.max(0, files) > limits.files)
          throw new QuotaExceeded("files", used.files + used.reservedFiles, limits.files);
        sql.exec(
          "INSERT INTO vault_reservations VALUES(?,?,?,?,?,?, 'pending') ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,bytes=excluded.bytes,files=excluded.files,state='pending'",
          id,
          operation,
          prefix,
          fingerprint,
          bytes,
          files,
        );
        sql.exec(
          "UPDATE vault_quota SET reserved_bytes=reserved_bytes+?,reserved_files=reserved_files+? WHERE id=1",
          Math.max(0, bytes),
          Math.max(0, files),
        );
      });
      return id;
    },
  };
}
