import { createHash } from "node:crypto";
import type { SourceFile } from "./catalog-source-github.ts";
import type { CatalogPackage, CatalogSourceApp } from "./catalog-sources.ts";

export type SourceArtifacts = {
  snapshot: Buffer;
  snapshotSha256: string;
  fileSha256: Record<string, string>;
};

export function createSourceArtifacts(
  packageName: CatalogPackage,
  files: readonly SourceFile[],
): SourceArtifacts {
  if (!files.some((file) => file.path === "package.json"))
    throw new Error(`${packageName} source snapshot requires package.json`);
  const ordered = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (new Set(ordered.map((file) => file.path)).size !== ordered.length)
    throw new Error(`${packageName} source snapshot contains duplicate paths`);
  if (ordered.some((file) => !isSafeSourcePath(file.path)))
    throw new Error(`${packageName} source snapshot only accepts safe relative paths`);
  let packageManifest: unknown;
  try {
    packageManifest = JSON.parse(ordered.find((file) => file.path === "package.json")!.content);
  } catch {
    throw new Error(`${packageName} source package.json is not valid JSON`);
  }
  if (!isRecord(packageManifest) || packageManifest.name !== packageName)
    throw new Error(`${packageName} source package.json must keep the package name ${packageName}`);
  const fileSha256 = Object.fromEntries(
    ordered.map((file) => [file.path, sha256(Buffer.from(file.content, "utf8"))]),
  );
  const snapshot = Buffer.from(
    `${JSON.stringify({ package: packageName, files: ordered }, null, 2)}\n`,
    "utf8",
  );
  return { snapshot, snapshotSha256: sha256(snapshot), fileSha256 };
}

export function updateSourceProvenance(
  current: Record<string, unknown>,
  app: CatalogSourceApp,
  artifacts: SourceArtifacts,
): Buffer {
  const provenance: Record<string, unknown> = { ...current };
  if ("sourceSha256" in provenance) provenance.sourceSha256 = artifacts.snapshotSha256;
  if ("snapshotSha256" in provenance) provenance.snapshotSha256 = artifacts.snapshotSha256;
  if ("catalogFileSha256" in provenance) provenance.catalogFileSha256 = artifacts.fileSha256;

  const previousCatalogSource = isRecord(provenance.catalogSource) ? provenance.catalogSource : {};
  provenance.catalogSource = {
    ...previousCatalogSource,
    repository: `https://github.com/${app.repository}`,
    commit: app.commit,
    fileSha256: artifacts.fileSha256,
    snapshotSha256: artifacts.snapshotSha256,
  };
  return Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}

export function isSafeSourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/")
  )
    return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
