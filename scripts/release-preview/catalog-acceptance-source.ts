import { createHash } from "node:crypto";
import { handleCatalog } from "../../src/catalog/worker.ts";
import { servedFrameworkVersion } from "../../framework-release.ts";
import type { AcceptanceApp } from "./catalog-acceptance-inventory.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new Error("Expected an identifier");
  return value;
}

// A stored public blob and its inline source have the same Git object identity.
export function sourceFilesDigest(input: unknown): string {
  if (!Array.isArray(input)) throw new Error("Source omitted its files");
  const paths = new Set<string>();
  const files = input
    .map((value: unknown) => {
      const file = record(value);
      if (typeof file.path !== "string" || paths.has(file.path))
        throw new Error("Invalid source path");
      paths.add(file.path);
      if (
        typeof file.object === "string" &&
        /^[a-f0-9]{40}$/.test(file.object) &&
        Number.isSafeInteger(file.size) &&
        Number(file.size) >= 0
      )
        return { path: file.path, object: file.object, size: Number(file.size) };
      if (
        typeof file.content !== "string" ||
        (file.encoding !== undefined && file.encoding !== "base64")
      )
        throw new Error("Invalid source file");
      const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
      const object = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      return { path: file.path, object, size: bytes.length };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return digest(JSON.stringify(files));
}

export async function expectedSource(app: AcceptanceApp, origin: string) {
  const path = `/catalog/apps/${encodeURIComponent(app.entry)}.json`;
  const response = await handleCatalog(new Request(`${origin}${path}`), async () => {
    throw new Error("Acceptance source must come from this checkout");
  });
  if (response.status !== 200) throw new Error("Expected local catalog source is unavailable");
  const text = await response.text();
  const source = record(JSON.parse(text));
  if (source.package !== app.package || !Array.isArray(source.files))
    throw new Error("Expected catalog package differs");
  const manifestFile = source.files.map(record).find((file) => file.path === "package.json");
  if (typeof manifestFile?.content !== "string") throw new Error("Source omitted its manifest");
  const manifest = record(JSON.parse(manifestFile.content));
  if (
    manifest.name !== app.package ||
    record(manifest.dependencies).apps !== servedFrameworkVersion
  )
    throw new Error("Expected source does not use the served framework");
  return {
    path,
    documentSha256: digest(JSON.stringify(source)),
    filesSha256: sourceFilesDigest(source.files),
    frameworkVersion: servedFrameworkVersion,
  };
}
