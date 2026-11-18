/** The repository's reviewed release declarations, loaded exactly as the release loads them. */
import { fileURLToPath } from "node:url";
import { loadDeclaredChanges } from "../declared-file.ts";
import { classEntries } from "../declared-class-contract.ts";

export async function repositoryDeclarations() {
  const declarations = await loadDeclaredChanges(
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  if (!declarations) throw new Error("release-declarations.json is missing");
  return declarations;
}

export async function poolWorkerClassEntry() {
  const entry = classEntries(await repositoryDeclarations()).find(
    (value) => value.fqn === "PoolWorker",
  );
  if (!entry) throw new Error("release-declarations.json declares no PoolWorker class");
  return entry;
}
