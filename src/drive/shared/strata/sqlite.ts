import type { RefStore, RefTransaction } from "./types.js";
import { DriveError, oid, operation } from "./errors.js";
import { decodeReceipt } from "./receipts.js";

export type SqlValue = string | number | ArrayBuffer | null;
export interface SqlStorage {
  exec(query: string, ...bindings: SqlValue[]): Iterable<Record<string, unknown>>;
}
export interface TransactionStorage {
  sql: SqlStorage;
  transactionSync<T>(body: () => T): T;
}

export function validateTransaction(transaction: RefTransaction) {
  operation(transaction.operation);
  if (
    !transaction.fingerprint ||
    transaction.fingerprint.length > 256 ||
    transaction.receipt.operation !== transaction.operation
  )
    throw new DriveError("invalid", "Invalid operation fingerprint or receipt");
  if (
    !transaction.changes.length ||
    transaction.changes.length > 32 ||
    new Set(transaction.changes.map((change) => change.ref)).size !== transaction.changes.length
  )
    throw new DriveError("invalid", "A ref transaction needs distinct bounded ref comparisons");
  for (const change of transaction.changes) {
    if (!/^refs\/heads\/(main|writers\/[A-Za-z0-9_-]{1,80})$/.test(change.ref))
      throw new DriveError("invalid", "Invalid ref transaction target");
    oid(change.next);
    if (change.expected !== null) oid(change.expected);
  }
  decodeReceipt(transaction.receipt);
  oid(transaction.receipt.oid);
}

export function createSqliteRefStore(storage: TransactionStorage): RefStore {
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS drive_refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS drive_receipts (operation TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL)",
  );
  const get = (ref: string) => {
    const row = [...sql.exec("SELECT oid FROM drive_refs WHERE name = ?", ref)][0];
    return typeof row?.oid === "string" ? oid(row.oid) : null;
  };
  const receipt = (id: string, fingerprint?: string) => {
    operation(id);
    const row = [
      ...sql.exec("SELECT fingerprint, receipt FROM drive_receipts WHERE operation = ?", id),
    ][0];
    if (!row) return null;
    if (fingerprint !== undefined && row.fingerprint !== fingerprint)
      throw new DriveError("invalid", "An operation id cannot identify a different request");
    if (typeof row.receipt !== "string")
      throw new DriveError("integrity", "Stored operation receipt is invalid");
    const value: unknown = JSON.parse(row.receipt);
    return decodeReceipt(value);
  };
  return {
    async get(ref) {
      return get(ref);
    },
    async receipt(id, fingerprint) {
      return receipt(id, fingerprint);
    },
    async publish(transaction) {
      validateTransaction(transaction);
      return storage.transactionSync(() => {
        const prior = receipt(transaction.operation, transaction.fingerprint);
        if (prior) return { applied: true, receipt: prior };
        const current = Object.fromEntries(
          transaction.changes.map((change) => [change.ref, get(change.ref)]),
        );
        if (transaction.changes.some((change) => current[change.ref] !== change.expected))
          return { applied: false, current };
        for (const change of transaction.changes)
          sql.exec(
            "INSERT INTO drive_refs(name, oid) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET oid = excluded.oid",
            change.ref,
            change.next,
          );
        sql.exec(
          "INSERT INTO drive_receipts(operation, fingerprint, receipt) VALUES (?, ?, ?)",
          transaction.operation,
          transaction.fingerprint,
          JSON.stringify(transaction.receipt),
        );
        return { applied: true, receipt: transaction.receipt };
      });
    },
  };
}
