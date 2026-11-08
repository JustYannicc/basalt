import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  fstatSync,
  ftruncateSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openSqliteReader } from "../../apps/pool/ui/sqlite-reader.ts";
import { registerFileVfs, validateSqliteSnapshot } from "../../apps/pool/ui/sqlite-file-vfs.ts";
import { managerBackup, rangedFile } from "./sqlite-upload-fixture.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { default: initSqlite } = await import(
  process.env.SQLITE_WASM_PACKAGE
    ? join(process.env.SQLITE_WASM_PACKAGE, "dist/node.mjs")
    : require.resolve("@sqlite.org/sqlite-wasm")
);
const sqlite = await initSqlite();

test("Manager Plus SQLite pages use real WASM, bounded reads, stable IDs and no private fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-upload-")),
    path = join(dir, "usage.sqlite");
  managerBackup(path);
  const wide = new DatabaseSync(path);
  wide.exec(
    "UPDATE usage_events SET id=9007199254740993, input_tokens=9007199254740993 WHERE id=1203",
  );
  wide.close();
  const before = readFileSync(path);
  const selected = rangedFile(path);
  const reader = openSqliteReader(sqlite, selected.file, selected.read);
  try {
    const pages = [];
    for (let page; (page = await reader.next()) !== null;) pages.push(page);
    assert.deepEqual(
      pages.map((page) => page.offset),
      [0, 200, 400],
    );
    assert.deepEqual(
      pages.map((page) => page.data.split("\n").length),
      [200, 200, 1],
    );
    assert.doesNotMatch(JSON.stringify(pages), /private-|raw_json|auth_index|api_key_hash/);
    const first = JSON.parse(pages[0].data.split("\n")[0]);
    assert.equal(first.cache_write_tokens, "2");
    assert.equal(first.input_tokens, "100");
    assert.match(first.account_ref, /^[a-f0-9]{64}$/);
    assert.equal(first.failed, false);
    const failure = JSON.parse(pages[0].data.split("\n")[6]);
    assert.equal(failure.failed, true);
    assert.equal(failure.status_code, 429);
    assert.equal(JSON.parse(pages[2].data).input_tokens, "9007199254740993");
    assert.ok(reader.metrics.maximumRead <= 65536, JSON.stringify(reader.metrics));
    assert.ok(reader.metrics.bytes < before.length / 2, "large private payload is not scanned");
    reader.close();
    const replay = openSqliteReader(sqlite, selected.file, selected.read);
    try {
      assert.deepEqual(await replay.next(), pages[0]);
    } finally {
      replay.close();
    }
    assert.deepEqual(readFileSync(path), before, "source bytes never change");
  } finally {
    reader.close();
    selected.close();
    rmSync(dir, { recursive: true });
  }
});

test("VFS zero-fills short reads, catches read errors and SQLite refuses writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-vfs-")),
    path = join(dir, "usage.sqlite");
  managerBackup(path, 1);
  const selected = rangedFile(path);
  let fail = false;
  const vfs = registerFileVfs(sqlite, selected.file, (blob) => {
    if (fail) throw new Error("read failure");
    return selected.read(blob);
  });
  const db = new sqlite.oo1.DB(vfs.filename, "r", vfs.name);
  const { capi: c, wasm } = sqlite;
  try {
    assert.throws(() => db.exec("DELETE FROM usage_events"), /readonly|read-only/i);
    const io = c.sqlite3_js_db_vfs(db);
    assert.ok(io);
    // Exercise callbacks through their registered WASM pointers, as SQLite calls them.
    const handle = new c.sqlite3_file();
    const methods = new c.sqlite3_io_methods();
    const name = wasm.allocCString(vfs.filename);
    const out = wasm.alloc(16);
    const vfsStruct = new c.sqlite3_vfs(c.sqlite3_vfs_find(vfs.name));
    try {
      assert.equal(
        wasm.functionEntry(vfsStruct.$xOpen)(
          vfsStruct.pointer,
          name,
          handle.pointer,
          c.SQLITE_OPEN_MAIN_DB | c.SQLITE_OPEN_READONLY,
          out,
        ),
        c.SQLITE_OK,
      );
      methods.dispose();
      const registered = new c.sqlite3_io_methods(handle.$pMethods);
      const xRead = wasm.functionEntry(registered.$xRead);
      wasm.heap8u().fill(123, out, out + 16);
      assert.equal(
        xRead(handle.pointer, out, 16, BigInt(selected.file.size - 4)),
        c.SQLITE_IOERR_SHORT_READ,
      );
      assert.deepEqual([...wasm.heap8u().subarray(out + 4, out + 16)], Array(12).fill(0));
      fail = true;
      assert.equal(xRead(handle.pointer, out, 16, 0n), c.SQLITE_IOERR_READ);
      assert.equal(
        wasm.functionEntry(registered.$xWrite)(handle.pointer, out, 1, 0n),
        c.SQLITE_READONLY,
      );
    } finally {
      handle.dispose();
      wasm.dealloc(name);
      wasm.dealloc(out);
    }
  } finally {
    db.close();
    vfs.dispose();
    selected.close();
    rmSync(dir, { recursive: true });
  }
});

test("WAL and truncated snapshots refuse before preview; a standalone backup reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-wal-")),
    path = join(dir, "usage.sqlite");
  managerBackup(path, 1);
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; INSERT INTO usage_events SELECT 9,printf('%064x',9),timestamp,provider,model,endpoint,service_tier,request_id,auth_index,api_key_hash,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reasoning_tokens,total_tokens,latency_ms,failed,fail_status_code,generate,raw_json FROM usage_events LIMIT 1",
  );
  let selected = rangedFile(path);
  try {
    assert.throws(() => validateSqliteSnapshot(selected.file, selected.read), /WAL/);
  } finally {
    selected.close();
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  db.close();
  selected = rangedFile(path);
  const reader = openSqliteReader(sqlite, selected.file, selected.read);
  try {
    assert.equal((await reader.next())!.data.split("\n").length, 2);
  } finally {
    reader.close();
    selected.close();
  }
  writeFileSync(path, readFileSync(path).subarray(0, -1));
  selected = rangedFile(path);
  try {
    assert.throws(
      () => validateSqliteSnapshot(selected.file, selected.read),
      /incomplete|checkpointed/,
    );
  } finally {
    selected.close();
    rmSync(dir, { recursive: true });
  }
});

test("File VFS keeps offsets beyond 4 GiB without allocating the file in memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-large-")),
    path = join(dir, "sparse.sqlite");
  const fd = openSync(path, "w");
  const offset = 5 * 1024 ** 3;
  try {
    ftruncateSync(fd, offset + 16);
    writeSync(fd, new Uint8Array([1, 2, 3, 4]), 0, 4, offset);
    assert.ok(fstatSync(fd).blocks * 512 < 1024 * 1024, "fixture must remain sparse");
  } finally {
    closeSync(fd);
  }
  const selected = rangedFile(path);
  const vfs = registerFileVfs(sqlite, selected.file, selected.read);
  const { capi: c, wasm } = sqlite;
  const handle = new c.sqlite3_file(),
    name = wasm.allocCString(vfs.filename),
    out = wasm.alloc(16);
  try {
    const registeredVfs = new c.sqlite3_vfs(c.sqlite3_vfs_find(vfs.name));
    assert.equal(
      wasm.functionEntry(registeredVfs.$xOpen)(
        registeredVfs.pointer,
        name,
        handle.pointer,
        c.SQLITE_OPEN_MAIN_DB | c.SQLITE_OPEN_READONLY,
        out,
      ),
      c.SQLITE_OK,
    );
    const methods = new c.sqlite3_io_methods(handle.$pMethods);
    assert.equal(
      wasm.functionEntry(methods.$xRead)(handle.pointer, out, 16, BigInt(offset)),
      c.SQLITE_OK,
    );
    assert.deepEqual(
      [...wasm.heap8u().subarray(out, out + 16)],
      [1, 2, 3, 4, ...Array(12).fill(0)],
    );
    assert.deepEqual(vfs.metrics, { reads: 1, bytes: 16, maximumRead: 16 });
  } finally {
    handle.dispose();
    wasm.dealloc(name);
    wasm.dealloc(out);
    vfs.dispose();
    selected.close();
    rmSync(dir, { recursive: true });
  }
});

test("invalid status metadata is refused before a page can be uploaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-status-")),
    path = join(dir, "usage.sqlite");
  managerBackup(path, 1);
  const db = new DatabaseSync(path);
  db.exec("UPDATE usage_events SET failed=1,fail_status_code='private-invalid-status'");
  db.close();
  const selected = rangedFile(path),
    reader = openSqliteReader(sqlite, selected.file, selected.read);
  try {
    await assert.rejects(reader.next(), (error) => {
      assert.doesNotMatch(String(error), /private-invalid-status/);
      return /invalid usage counter/.test(String(error));
    });
  } finally {
    reader.close();
    selected.close();
    rmSync(dir, { recursive: true });
  }
});
