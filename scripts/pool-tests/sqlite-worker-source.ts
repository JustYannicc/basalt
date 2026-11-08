import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImportSource, ImportPage } from "../../apps/pool/ui/import-source.ts";

/** Drive the actual compiled browser worker in a Node worker, with ranged File I/O. */
export function compiledSqliteSource(path: string, output: string): ImportSource {
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  return {
    label: "usage.sqlite",
    format: "cpamp-v1-jsonl",
    async *pages() {
      const worker = new Worker(new URL("./sqlite-worker-node.mjs", import.meta.url), {
        workerData: { path, entry: pathToFileURL(join(output, manifest.entry)).href },
      });
      const next = (first = false) =>
        new Promise<ImportPage | null>((resolve, reject) => {
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          const received = (message: { error?: string; page: ImportPage | null }) => {
            cleanup();
            if (message.error) reject(new Error(message.error));
            else resolve(message.page);
          };
          const cleanup = () => {
            worker.off("message", received);
            worker.off("error", failed);
          };
          worker.once("message", received);
          worker.once("error", failed);
          worker.postMessage({ file: first });
        });
      try {
        let page = await next(true);
        while (page !== null) {
          yield page;
          page = await next();
        }
      } finally {
        await worker.terminate();
      }
    },
  };
}
