import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type WorkerUpload = {
  readonly worker: string;
  readonly sources: Readonly<Record<string, number>>;
};

/**
 * The API definitions sso serves no route of. A module sso imports for something else that
 * defines another route group's handlers at its top level keeps the whole API and every contract
 * it names, which once cost sso about 211 KB of its upload; such a group is marked pure, so only
 * the Worker that serves it keeps it.
 */
const apiDefinitions = [
  "apps/hosted/server/src/contracts/api.ts",
  "apps/hosted/cloud/src/contracts/api.ts",
  "packages/app-management/src/contracts/api.ts",
];

export function assertSsoRuntimeBundle(upload: WorkerUpload) {
  if (upload.worker !== "sso" || Object.keys(upload.sources).length === 0)
    throw new Error("Expected the attributed production sso upload");
  const retained = Object.keys(upload.sources).filter((source) => apiDefinitions.includes(source));
  if (retained.length)
    throw new Error(
      `The sso Worker must not upload an API definition it serves no route of: ${retained.join(", ")}`,
    );
}

export function checkSsoRuntimeBundle() {
  const path = fileURLToPath(
    new URL("../.upstream/apps/hosted/cloud/.generated/worker-uploads/sso.json", import.meta.url),
  );
  assertSsoRuntimeBundle(JSON.parse(readFileSync(path, "utf8")));
}
