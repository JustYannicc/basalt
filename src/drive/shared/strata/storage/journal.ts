import * as Schema from "effect/Schema";
import { DriveError } from "../errors.js";
import { receiptSchema } from "../receipts.js";
import { serialized } from "../serial.js";
import { createSqliteRefStore, type TransactionStorage, validateTransaction } from "../sqlite.js";
import type { RefStore } from "../types.js";
import { type Bucket, readRecord, records } from "./bucket.js";

const transactionSchema = Schema.Struct({
  operation: Schema.String,
  fingerprint: Schema.String,
  changes: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      expected: Schema.NullOr(Schema.String),
      next: Schema.String,
    }),
  ),
  receipt: receiptSchema,
});
const recordSchema = Schema.Struct({ sequence: Schema.Number, transaction: transactionSchema });
const decodeRecord = (value: unknown) => {
  const record = Schema.decodeUnknownSync(recordSchema)(value);
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1)
    throw new DriveError("integrity", "Invalid ref journal sequence");
  validateTransaction(record.transaction);
  return record;
};

// One instance belongs to one Durable Object. Every ref writer must use this journal.
export function createJournal(bucket: Bucket, storage: TransactionStorage, prefix: string) {
  const raw = createSqliteRefStore(storage),
    run = serialized(),
    { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS drive_journal (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL, pending TEXT)",
  );
  sql.exec("INSERT OR IGNORE INTO drive_journal(id, sequence, pending) VALUES (1, 0, NULL)");
  const state = () => {
    const row = [...sql.exec("SELECT sequence, pending FROM drive_journal WHERE id = 1")][0];
    if (
      typeof row?.sequence !== "number" ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 0 ||
      (row.pending !== null && typeof row.pending !== "string")
    )
      throw new DriveError("integrity", "Invalid ref journal state");
    return { sequence: row.sequence, pending: row.pending };
  };
  const key = (sequence: number) => `${prefix}refs/${String(sequence).padStart(16, "0")}.json`;
  const apply = async (record: ReturnType<typeof decodeRecord>) => {
    const result = await raw.publish(record.transaction);
    if (!result.applied)
      throw new DriveError("integrity", "Durable ref journal does not match the expected Git head");
    storage.transactionSync(() => {
      if (state().sequence !== record.sequence - 1)
        throw new DriveError("integrity", "Durable ref journal sequence changed");
      sql.exec(
        "UPDATE drive_journal SET sequence = ?, pending = NULL WHERE id = 1",
        record.sequence,
      );
    });
    return result;
  };
  const finishPending = async () => {
    const current = state();
    if (!current.pending) return;
    const value: unknown = JSON.parse(current.pending);
    const record = decodeRecord(value);
    if (record.sequence !== current.sequence + 1)
      throw new DriveError("integrity", "Pending ref journal sequence is invalid");
    await bucket.put(key(record.sequence), current.pending);
    await apply(record);
  };
  const refs: RefStore = {
    get: (ref) =>
      run(async () => {
        await finishPending();
        return raw.get(ref);
      }),
    receipt: (id, fingerprint) =>
      run(async () => {
        await finishPending();
        return raw.receipt(id, fingerprint);
      }),
    publish: (request) =>
      run(async () => {
        validateTransaction(request);
        await finishPending();
        const prior = await raw.receipt(request.operation, request.fingerprint);
        if (prior) return { applied: true, receipt: prior };
        const current = Object.fromEntries(
          await Promise.all(
            request.changes.map(async (change) => [change.ref, await raw.get(change.ref)]),
          ),
        );
        if (request.changes.some((change) => current[change.ref] !== change.expected))
          return { applied: false, current };
        const record = { sequence: state().sequence + 1, transaction: request };
        const text = JSON.stringify(record);
        if (new TextEncoder().encode(text).length > 512 * 1024)
          throw new DriveError("capacity", "Ref journal record exceeds its byte limit");
        storage.transactionSync(() => {
          if (state().pending)
            throw new DriveError("integrity", "A ref transaction is already pending");
          sql.exec("UPDATE drive_journal SET pending = ? WHERE id = 1", text);
        });
        await finishPending();
        return { applied: true, receipt: request.receipt };
      }),
  };
  const recover = () =>
    run(async () => {
      await finishPending();
      for await (const name of records(bucket, `${prefix}refs/`, key(state().sequence))) {
        const record = decodeRecord(await readRecord(bucket, name));
        if (name !== key(record.sequence) || record.sequence !== state().sequence + 1)
          throw new DriveError("integrity", "Ref journal contains a gap or invalid record name");
        await apply(record);
      }
    });
  return { refs, recover };
}
