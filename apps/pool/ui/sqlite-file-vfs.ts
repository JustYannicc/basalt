import type { Sqlite3Static, Sqlite3Result } from "@sqlite.org/sqlite-wasm";

/** The browser File is immutable to this reader; no filesystem, journal, or whole-file copy. */
export function registerFileVfs(
  sqlite: Sqlite3Static,
  file: Blob,
  read: (slice: Blob) => ArrayBuffer,
) {
  const { capi: c, wasm } = sqlite;
  const io = new c.sqlite3_io_methods();
  const vfs = new c.sqlite3_vfs();
  const filename = "/usage.sqlite";
  const metrics = { reads: 0, bytes: 0, maximumRead: 0 };
  // Every callback reachable from C catches JS failures and returns a SQLite result code.
  const guarded =
    <A extends unknown[]>(code: Sqlite3Result, fn: (...args: A) => Sqlite3Result) =>
    (...args: A) => {
      try {
        return fn(...args);
      } catch {
        return code;
      }
    };
  const ok = () => c.SQLITE_OK;
  const readonly = () => c.SQLITE_READONLY;
  Object.assign(io, { $iVersion: 1 });
  vfs.$iVersion = 1;
  const fileStruct = new c.sqlite3_file();
  vfs.$szOsFile = fileStruct.structInfo.sizeof;
  fileStruct.dispose();
  vfs.$mxPathname = 128;
  vfs.setMemberCString("zName", "usage-file");
  const methods = {
    xClose: ok,
    xRead: guarded(
      c.SQLITE_IOERR_READ,
      (_file: number, destination: number, amount: number, rawOffset: number) => {
        const offset = Number(rawOffset);
        if (!Number.isSafeInteger(offset) || offset < 0 || amount < 0 || amount > 1024 * 1024)
          return c.SQLITE_IOERR_READ;
        const target = wasm.heap8u().subarray(destination, destination + amount);
        if (target.length !== amount) return c.SQLITE_IOERR_READ;
        target.fill(0);
        const data = new Uint8Array(read(file.slice(offset, offset + amount)));
        if (data.length > amount) return c.SQLITE_IOERR_READ;
        target.set(data);
        metrics.reads++;
        metrics.bytes += data.length;
        metrics.maximumRead = Math.max(metrics.maximumRead, amount);
        return data.length === amount ? c.SQLITE_OK : c.SQLITE_IOERR_SHORT_READ;
      },
    ),
    xWrite: readonly,
    xTruncate: readonly,
    xSync: readonly,
    xFileSize: guarded(c.SQLITE_IOERR_FSTAT, (_file: number, out: number) => {
      wasm.poke64(out, BigInt(file.size));
      return c.SQLITE_OK;
    }),
    xLock: ok,
    xUnlock: ok,
    xCheckReservedLock: guarded(c.SQLITE_IOERR_CHECKRESERVEDLOCK, (_file: number, out: number) => {
      wasm.poke32(out, 0);
      return c.SQLITE_OK;
    }),
    xFileControl: () => c.SQLITE_NOTFOUND,
    xSectorSize: () => 4096,
    xDeviceCharacteristics: () => c.SQLITE_IOCAP_IMMUTABLE,
  };
  // The package types incorrectly declare sector sizes/device flags as SQLite result codes.
  io.installMethods(methods);
  sqlite.vfs.installVfs({
    vfs: {
      struct: vfs,
      methods: {
        xOpen: guarded(c.SQLITE_CANTOPEN, (_vfs, name, handle, flags, out) => {
          if (
            wasm.cstrToJs(name) !== filename ||
            !(flags & c.SQLITE_OPEN_MAIN_DB) ||
            !(flags & c.SQLITE_OPEN_READONLY) ||
            flags & (c.SQLITE_OPEN_READWRITE | c.SQLITE_OPEN_CREATE)
          )
            return c.SQLITE_CANTOPEN;
          wasm.pokePtr(handle, io.pointer);
          if (out) wasm.poke32(out, c.SQLITE_OPEN_READONLY);
          return c.SQLITE_OK;
        }),
        xDelete: readonly,
        xAccess: guarded(c.SQLITE_IOERR_ACCESS, (_vfs, name, flags, out) => {
          wasm.poke32(
            out,
            wasm.cstrToJs(name) === filename && flags !== c.SQLITE_ACCESS_READWRITE ? 1 : 0,
          );
          return c.SQLITE_OK;
        }),
        xFullPathname: guarded(c.SQLITE_CANTOPEN, (_vfs, name, size, out) => {
          if (wasm.cstrToJs(name) !== filename || size <= filename.length) return c.SQLITE_CANTOPEN;
          wasm.heap8u().set(new TextEncoder().encode(filename + "\0"), out);
          return c.SQLITE_OK;
        }),
        xRandomness: () => 0,
        xSleep: () => 0,
        xCurrentTime: guarded(c.SQLITE_ERROR, (_vfs, out) => {
          wasm.poke64f(out, 2440587.5 + Date.now() / 86400000);
          return c.SQLITE_OK;
        }),
      },
    },
  });
  return {
    filename,
    name: "usage-file",
    metrics,
    dispose() {
      c.sqlite3_vfs_unregister(vfs);
      vfs.dispose();
      io.dispose();
    },
  };
}

/** WAL headers cannot prove that a selected main file contains its unselected journal. */
export function validateSqliteSnapshot(file: Blob, read: (slice: Blob) => ArrayBuffer) {
  const bytes = new Uint8Array(read(file.slice(0, 100)));
  if (bytes.length !== 100 || new TextDecoder().decode(bytes.slice(0, 16)) !== "SQLite format 3\0")
    throw new Error("This isn't a complete SQLite backup.");
  if (bytes[18] !== 1 || bytes[19] !== 1)
    throw new Error(
      "This database may need a WAL file. Create a standalone SQLite backup with journal_mode=DELETE, then choose that backup. Don't upload a live database or its WAL separately.",
    );
  const header = new DataView(bytes.buffer);
  const pageSize = header.getUint16(16) === 1 ? 65536 : header.getUint16(16);
  if (
    pageSize < 512 ||
    pageSize > 65536 ||
    (pageSize & (pageSize - 1)) !== 0 ||
    file.size % pageSize !== 0 ||
    header.getUint32(24) !== header.getUint32(92) ||
    header.getUint32(28) * pageSize !== file.size
  )
    throw new Error(
      "This backup is incomplete or wasn't checkpointed. Create a fresh standalone SQLite backup.",
    );
}
