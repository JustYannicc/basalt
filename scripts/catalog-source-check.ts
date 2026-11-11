import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSourceArtifacts,
  isRecord,
  updateSourceProvenance,
} from "./catalog-source-artifacts.ts";
import type { CatalogSourceManifest } from "./catalog-sources.ts";

// Immutable pins are checked against the provenance recorded by --write. Checking
// must never refresh those trusted hashes from the bytes it is trying to verify.
export async function checkCatalogSources(
  root: string,
  manifest: CatalogSourceManifest,
): Promise<void> {
  const problems: string[] = [];
  for (const app of manifest.apps) {
    try {
      const directory = join(root, "src/catalog", app.package);
      const sourcePath = join(directory, "source.json");
      const provenancePath = join(directory, "provenance.json");
      const source = await readFile(sourcePath);
      const provenanceBytes = await readFile(provenancePath);
      const snapshot: unknown = JSON.parse(source.toString("utf8"));
      const provenance: unknown = JSON.parse(provenanceBytes.toString("utf8"));
      function drift(detail: string): never {
        throw new Error(
          `Catalog source drift for ${app.package}: ${detail}. Run with --write to verify the pin on GitHub and update it.`,
        );
      }
      if (!isRecord(provenance) || !isRecord(provenance.catalogSource))
        drift("missing committed catalogSource provenance");
      const pin = provenance.catalogSource;
      if (pin.repository !== `https://github.com/${app.repository}` || pin.commit !== app.commit)
        drift(
          `provenance repository/commit ${pin.repository}@${pin.commit} -> https://github.com/${app.repository}@${app.commit}`,
        );
      if (!isRecord(snapshot) || snapshot.package !== app.package || !Array.isArray(snapshot.files))
        drift("invalid snapshot package or files");
      const files = snapshot.files.map((file: unknown) => {
        if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string")
          return drift("invalid snapshot file");
        return { path: file.path, content: file.content };
      });
      const paths = files.map((file) => file.path).sort();
      if (JSON.stringify(paths) !== JSON.stringify([...app.files].sort()))
        drift(
          `snapshot.files: ${JSON.stringify(paths)} -> ${JSON.stringify([...app.files].sort())}`,
        );
      const artifacts = createSourceArtifacts(app.package, files);
      if (!source.equals(artifacts.snapshot)) drift("snapshot bytes are not canonical");
      const expectedProvenance = updateSourceProvenance(provenance, app, artifacts);
      if (!provenanceBytes.equals(expectedProvenance)) {
        const changes = provenanceChanges(
          provenance,
          JSON.parse(expectedProvenance.toString("utf8")),
        );
        drift(
          `snapshot or file SHA-256 does not match committed provenance: ${changes.join(", ") || "provenance bytes are not canonical"}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(
        message.startsWith("Catalog source drift for ")
          ? message
          : `Catalog source drift for ${app.package}: ${message}`,
      );
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
}

export function provenanceChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const old = before[key],
      current = after[key];
    if (isRecord(old) && isRecord(current)) return provenanceChanges(old, current, path);
    return JSON.stringify(old) === JSON.stringify(current)
      ? []
      : [`${path}: ${JSON.stringify(old) ?? "missing"} -> ${JSON.stringify(current) ?? "missing"}`];
  });
}
