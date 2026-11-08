import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rangedFile } from "./sqlite-upload-fixture.ts";

// Node supplies only browser platform I/O here. The worker/chunks/WASM are unmodified compiler output.
globalThis.self = globalThis;
globalThis.WorkerGlobalScope = Object;
globalThis.location = { href: workerData.entry };
globalThis.postMessage = (message) => parentPort.postMessage(message);
Object.defineProperty(globalThis, "navigator", {
  value: {
    storage: {
      getDirectory() {
        throw new Error("The upload reader must not open browser storage");
      },
    },
  },
  configurable: true,
});
globalThis.crossOriginIsolated = true;
globalThis.Worker = class {
  constructor() {
    throw new Error("The upload reader must not start an OPFS proxy");
  }
};
globalThis.fetch = (input) =>
  String(input).startsWith("file:")
    ? Promise.resolve(
        new Response(readFileSync(fileURLToPath(input)), {
          headers: { "content-type": "application/wasm" },
        }),
      )
    : Promise.reject(new Error("Unexpected network request from the upload reader"));
const file = rangedFile(workerData.path);
globalThis.FileReaderSync = class {
  readAsArrayBuffer(blob) {
    return file.read(blob);
  }
};
await import(workerData.entry);
parentPort.on("message", (message) => {
  globalThis.onmessage({ data: message.file ? { file: file.file } : {} });
});
