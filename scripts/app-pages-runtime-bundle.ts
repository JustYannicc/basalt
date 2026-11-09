import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type WorkerUpload = {
  readonly worker: string;
  readonly sources: Readonly<Record<string, number>>;
};

/** App pages use native HTML parsing, remote storage and a crypto/path platform. */
export function assertAppPagesRuntimeBundle(upload: WorkerUpload) {
  if (upload.worker !== "app-pages" || Object.keys(upload.sources).length === 0)
    throw new Error("Expected the attributed production AppPages upload");
  const retained = Object.keys(upload.sources).filter((source) =>
    /node_modules\/(?:parse5\/|@effect\/platform-node(?:-shared)?\/dist\/(?:NodeFileSystem|NodeChildProcessSpawner|NodeTerminal|NodeStdio)\.js$)/.test(
      source,
    ),
  );
  if (retained.length)
    throw new Error(
      `AppPages must not upload an HTML parser or local OS services: ${retained.join(", ")}`,
    );
}

export function checkAppPagesRuntimeBundle() {
  const path = fileURLToPath(
    new URL(
      "../.upstream/apps/hosted/cloud/.generated/worker-uploads/app-pages.json",
      import.meta.url,
    ),
  );
  assertAppPagesRuntimeBundle(JSON.parse(readFileSync(path, "utf8")));
}
