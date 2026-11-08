import type { Sqlite3Static, SqlValue } from "@sqlite.org/sqlite-wasm";
import { registerFileVfs, validateSqliteSnapshot } from "./sqlite-file-vfs.ts";
import { sqliteColumns, sqliteMetadata } from "./sqlite-metadata.ts";

/** Own one read-only connection and one bounded keyset page for the selected snapshot. */
export function openSqliteReader(
  sqlite: Sqlite3Static,
  file: Blob,
  read: (slice: Blob) => ArrayBuffer,
) {
  validateSqliteSnapshot(file, read);
  const vfs = registerFileVfs(sqlite, file, read);
  let db: InstanceType<Sqlite3Static["oo1"]["DB"]> | undefined;
  try {
    db = new sqlite.oo1.DB(vfs.filename, "r", vfs.name);
    db.exec(
      "PRAGMA hard_heap_limit=33554432; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY",
    );
    const table = db.selectObject("SELECT type, sql FROM sqlite_schema WHERE name='usage_events'");
    if (
      table?.type !== "table" ||
      typeof table.sql !== "string" ||
      /VIRTUAL|WITHOUT\s+ROWID/i.test(table.sql)
    )
      throw new Error("Choose a Manager Plus usage.sqlite backup containing usage_events.");
    const columns = db.exec({
      sql: "PRAGMA table_info(usage_events)",
      rowMode: "object",
      returnValue: "resultRows",
    });
    if (
      !sqliteColumns.every((name) => columns.some((column) => column.name === name)) ||
      columns.filter((column) => Number(column.pk) > 0).length !== 1 ||
      !columns.some(
        (column) => column.name === "id" && column.type === "INTEGER" && column.pk === 1,
      )
    )
      throw new Error("This Manager Plus backup has an unsupported usage schema.");
    const lower = db.selectValue("SELECT min(id) FROM usage_events");
    if (lower !== null && ((typeof lower !== "number" && typeof lower !== "bigint") || lower <= 0))
      throw new Error("The backup contains invalid usage record IDs.");
    const upper = db.selectValue("SELECT max(id) FROM usage_events") ?? 0;
    let after: SqlValue = 0,
      offset = 0,
      closed = false;
    const connection = db;
    // Substr bounds each selected value even when a damaged database stores text in integer columns.
    const selected = sqliteColumns
      .map((name) =>
        name === "id"
          ? name
          : `CASE WHEN typeof(${name}) IN ('text','blob') THEN substr(${name},1,4097) ELSE ${name} END AS ${name}`,
      )
      .join(",");
    return {
      metrics: vfs.metrics,
      async next() {
        if (closed) throw new Error("The selected backup is closed. Choose it again.");
        const rows = connection.exec({
          sql: `SELECT ${selected} FROM usage_events WHERE id>? AND id<=? ORDER BY id LIMIT 200`,
          bind: [after, upper],
          rowMode: "object",
          returnValue: "resultRows",
        });
        if (!rows.length) return null;
        const metadata = [];
        for (const row of rows) {
          if (Object.values(row).some((value) => typeof value === "string" && value.length > 4096))
            throw new Error("The backup contains oversized usage metadata.");
          metadata.push(JSON.stringify(await sqliteMetadata(row)));
        }
        after = rows.at(-1)!.id;
        const page = { format: "cpamp-v1-jsonl" as const, data: metadata.join("\n"), offset };
        if (new TextEncoder().encode(page.data).byteLength > 8 * 1024 * 1024)
          throw new Error("A usage page exceeds 8 MiB.");
        offset += rows.length;
        return page;
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          connection.close();
        } finally {
          vfs.dispose();
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } finally {
      vfs.dispose();
    }
    throw error;
  }
}
