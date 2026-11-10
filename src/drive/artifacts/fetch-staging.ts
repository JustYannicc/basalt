import { randomUUID } from "node:crypto";
import type { TransactionStorage } from "../shared/strata/sqlite.ts";
import type { Bytes } from "../shared/strata/types.ts";
import type { EntryHeader } from "../shared/strata/git/pack-entries.ts";
import { RetainedBytes } from "./stream-window.ts";
import { ProtocolError } from "./wire.ts";

const partBytes = 1024 * 1024;

/** One active fetch per vault. SQL owns the pack-wide index, dependencies and ready queue. */
export function createFetchStaging(storage: TransactionStorage) {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_fetch_offsets (fetch TEXT NOT NULL, offset INTEGER NOT NULL, oid TEXT NOT NULL, PRIMARY KEY (fetch, offset))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_fetch_deltas (fetch TEXT NOT NULL, offset INTEGER NOT NULL, base_offset INTEGER, base_oid TEXT, bytes INTEGER NOT NULL, ready_oid TEXT, PRIMARY KEY (fetch, offset))",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS vault_fetch_delta_offsets ON vault_fetch_deltas(fetch, base_offset)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS vault_fetch_delta_oids ON vault_fetch_deltas(fetch, base_oid)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS vault_fetch_delta_ready ON vault_fetch_deltas(fetch, ready_oid)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_fetch_delta_parts (fetch TEXT NOT NULL, offset INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (fetch, offset, part))",
  );
  return {
    begin(retained: RetainedBytes) {
      // A retry after an object eviction cannot use an earlier pack's offsets or dependencies.
      storage.transactionSync(() => {
        sql.exec("DELETE FROM vault_fetch_delta_parts");
        sql.exec("DELETE FROM vault_fetch_deltas");
        sql.exec("DELETE FROM vault_fetch_offsets");
      });
      const fetch = randomUUID(),
        bookkeeping = {},
        buffers = {};
      // At most one SQL row, entry header and ready item are live. Reserve their JS/string
      // overhead as well as the session and parser's fixed bookkeeping, independent of pack size.
      retained.set(bookkeeping, 4096);
      const oidAt = (offset: number) => {
        const row = [
          ...sql.exec(
            "SELECT oid FROM vault_fetch_offsets WHERE fetch = ? AND offset = ?",
            fetch,
            offset,
          ),
        ][0];
        return row ? String(row.oid) : undefined;
      };
      return {
        oidAt,
        defer(offset: number, header: EntryHeader, content: Bytes) {
          storage.transactionSync(() => {
            sql.exec(
              "INSERT INTO vault_fetch_deltas(fetch, offset, base_offset, base_oid, bytes) VALUES (?, ?, ?, ?, ?)",
              fetch,
              offset,
              header.kind === "ofs_delta" ? offset - header.baseDistance! : null,
              header.baseOid ?? null,
              content.length,
            );
            for (let part = 0; part * partBytes < content.length; part++) {
              const bytes = content.slice(part * partBytes, (part + 1) * partBytes);
              retained.set(buffers, bytes.byteLength);
              sql.exec(
                "INSERT INTO vault_fetch_delta_parts(fetch, offset, part, data) VALUES (?, ?, ?, ?)",
                fetch,
                offset,
                part,
                bytes.buffer,
              );
            }
            retained.set(buffers, 0);
          });
        },
        resolved(offset: number, oid: string) {
          storage.transactionSync(() => {
            sql.exec(
              "INSERT INTO vault_fetch_offsets(fetch, offset, oid) VALUES (?, ?, ?)",
              fetch,
              offset,
              oid,
            );
            sql.exec(
              "DELETE FROM vault_fetch_delta_parts WHERE fetch = ? AND offset = ?",
              fetch,
              offset,
            );
            sql.exec(
              "DELETE FROM vault_fetch_deltas WHERE fetch = ? AND offset = ?",
              fetch,
              offset,
            );
            sql.exec(
              "UPDATE vault_fetch_deltas SET ready_oid = ? WHERE fetch = ? AND base_offset = ?",
              oid,
              fetch,
              offset,
            );
            sql.exec(
              "UPDATE vault_fetch_deltas SET ready_oid = ? WHERE fetch = ? AND base_oid = ?",
              oid,
              fetch,
              oid,
            );
          });
        },
        next() {
          const row = [
            ...sql.exec(
              "SELECT offset, bytes, ready_oid FROM vault_fetch_deltas WHERE fetch = ? AND ready_oid IS NOT NULL LIMIT 1",
              fetch,
            ),
          ][0];
          if (!row) return undefined;
          const offset = Number(row.offset),
            content = new Uint8Array(Number(row.bytes));
          retained.set(buffers, content.byteLength);
          for (let part = 0, at = 0; at < content.length; part++) {
            const row = [
              ...sql.exec(
                "SELECT data FROM vault_fetch_delta_parts WHERE fetch = ? AND offset = ? AND part = ?",
                fetch,
                offset,
                part,
              ),
            ][0];
            if (!(row?.data instanceof ArrayBuffer) && !(row?.data instanceof Uint8Array))
              throw new ProtocolError("Missing staged delta");
            const data = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : row.data;
            retained.set(buffers, content.byteLength + data.buffer.byteLength);
            content.set(data, at);
            at += data.length;
          }
          retained.set(buffers, content.byteLength);
          return { offset, oid: String(row.ready_oid), content };
        },
        release() {
          retained.set(buffers, 0);
        },
        pending() {
          return (
            [...sql.exec("SELECT 1 FROM vault_fetch_deltas WHERE fetch = ? LIMIT 1", fetch)]
              .length > 0
          );
        },
        close() {
          storage.transactionSync(() => {
            sql.exec("DELETE FROM vault_fetch_delta_parts WHERE fetch = ?", fetch);
            sql.exec("DELETE FROM vault_fetch_deltas WHERE fetch = ?", fetch);
            sql.exec("DELETE FROM vault_fetch_offsets WHERE fetch = ?", fetch);
          });
          retained.set(buffers, 0);
          retained.set(bookkeeping, 0);
        },
      };
    },
  };
}
