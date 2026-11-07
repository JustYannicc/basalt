import { DatabaseSync } from "node:sqlite";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Manager Plus's retained usage_events schema, with synthetic private fields. */
export function managerBackup(path: string, count = 401) {
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE usage_events(id INTEGER PRIMARY KEY,event_hash TEXT,timestamp TEXT,provider TEXT,model TEXT,endpoint TEXT,service_tier TEXT,request_id TEXT,auth_index TEXT,api_key_hash TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,latency_ms INTEGER,failed INTEGER,fail_status_code INTEGER,generate INTEGER,raw_json TEXT)`,
  );
  const insert = db.prepare(
    "INSERT INTO usage_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  db.exec("BEGIN");
  for (let i = 1; i <= count; i++)
    insert.run(
      i * 3,
      i.toString(16).padStart(64, "0"),
      "2026-05-05T11:32:18.619Z",
      "fixture",
      "fixture-model",
      "/v1/responses",
      null,
      "private-request",
      "private-account",
      "private-key",
      100,
      10,
      4,
      2,
      3,
      110,
      200,
      i % 7 === 0 ? 1 : 0,
      i % 7 === 0 ? 429 : 0,
      1,
      i === 1 ? "private-message".repeat(150000) : "private-message",
    );
  db.exec("COMMIT");
  db.close();
}

/** Node test adapter for File.slice/FileReaderSync; every call performs only a ranged disk read. */
export function rangedFile(path: string) {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  const ranges = new WeakMap<Blob, { start: number; end: number }>();
  const file = {
    size,
    slice(start = 0, end = size) {
      const slice = new Blob();
      ranges.set(slice, { start: Math.min(start, size), end: Math.min(end, size) });
      return slice;
    },
  } as Blob;
  return {
    file,
    read(slice: Blob) {
      const range = ranges.get(slice);
      if (!range) throw new Error("Unregistered range");
      const bytes = new Uint8Array(Math.max(0, range.end - range.start));
      const length = readSync(fd, bytes, 0, bytes.length, range.start);
      return bytes.buffer.slice(0, length);
    },
    close() {
      closeSync(fd);
    },
  };
}
