import type { ImportPage, ImportSource } from "./import-source.ts";

/** A worker lives only while a page iterator is open, including cancellation and failed previews. */
export function sqliteSource(file: File): ImportSource {
  return {
    label: file.name,
    format: "cpamp-v1-jsonl",
    async *pages() {
      const entry = document.querySelector<HTMLScriptElement>("script[data-usage-sqlite-worker]");
      if (!entry?.src)
        throw new Error("The SQLite reader is missing. Reload this page and try again.");
      const worker = new Worker(entry.src, { type: "module" });
      const next = (file?: File) =>
        new Promise<ImportPage | null>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<{ page: ImportPage | null; error?: string }>) => {
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data.page);
          };
          worker.onerror = () =>
            reject(
              new Error("The SQLite reader stopped. Reload the page or choose the backup again."),
            );
          worker.onmessageerror = () =>
            reject(new Error("Couldn't read the SQLite reader's response."));
          worker.postMessage({ file });
        });
      try {
        let page = await next(file);
        while (page !== null) {
          yield page;
          page = await next();
        }
      } finally {
        worker.terminate();
      }
    },
  };
}
