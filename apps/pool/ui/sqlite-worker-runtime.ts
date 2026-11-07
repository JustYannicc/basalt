import initSqlite from "@sqlite.org/sqlite-wasm";
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm";
import { openSqliteReader } from "./sqlite-reader.ts";

declare const FileReaderSync: new () => { readAsArrayBuffer(blob: Blob): ArrayBuffer };
let reader: ReturnType<typeof openSqliteReader> | undefined;
let busy = false;
export async function readMessage(event: MessageEvent<{ file?: File }>) {
  if (busy) {
    self.postMessage({ error: "The backup reader is already busy." });
    return;
  }
  busy = true;
  try {
    if (event.data.file) {
      reader?.close();
      // The package's declaration omits the supported Emscripten initializer options.
      const initialize = initSqlite as (options: {
        locateFile: () => string;
        wasmMemory: WebAssembly.Memory;
      }) => ReturnType<typeof initSqlite>;
      // This reader never uses browser storage or SQLite's optional OPFS proxy workers.
      Object.assign(globalThis, {
        sqlite3ApiConfig: {
          disable: {
            vfs: {
              opfs: true,
              "opfs-vfs": true,
              "opfs-sahpool": true,
              "opfs-wl": true,
              kvvfs: true,
            },
          },
        },
      });
      const sqlite = await initialize({
        locateFile: () => wasmUrl,
        wasmMemory: new WebAssembly.Memory({ initial: 128, maximum: 1024 }),
      });
      const files = new FileReaderSync();
      reader = openSqliteReader(sqlite, event.data.file, (blob) => files.readAsArrayBuffer(blob));
    }
    if (!reader) throw new Error("Choose a SQLite backup before reading usage.");
    const page = await reader.next();
    self.postMessage({ page });
    if (page === null) {
      reader.close();
      reader = undefined;
    }
  } catch (error) {
    reader?.close();
    reader = undefined;
    self.postMessage({
      error: error instanceof Error ? error.message : "Couldn't read this SQLite backup.",
    });
  } finally {
    busy = false;
  }
}
