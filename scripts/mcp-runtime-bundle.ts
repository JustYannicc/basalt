import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type WorkerUpload = {
  readonly worker: string;
  readonly sources: Readonly<Record<string, number>>;
};

const migrationSources = [
  "packages/sdk/src/implementation/storage.ts",
  "packages/sdk/src/implementation/storage-migrations.ts",
  "packages/sdk/src/implementation/storage-migration-error.ts",
  "packages/app-registry/src/implementation/storage.ts",
  "packages/fumadb-effect/src/implementation/migration/",
  "packages/fumadb-effect/src/implementation/sql/migrator.ts",
  "packages/fumadb-effect/src/implementation/sql/introspect.ts",
  "packages/fumadb-effect/src/implementation/sql/ddl.ts",
  "packages/fumadb-effect/src/implementation/sql/sqlite-transformer.ts",
];

/** Deployment owns schema changes. No MCP request may load that engine, even on first boot. */
export function assertMcpRuntimeBundle(upload: WorkerUpload) {
  if (upload.worker !== "mcp-server" || Object.keys(upload.sources).length === 0)
    throw new Error("Expected the attributed production MCP upload");
  const retained = Object.keys(upload.sources).filter((source) =>
    migrationSources.some((path) => path.endsWith("/") ? source.startsWith(path) : source === path)
      || /node_modules\/kysely\/dist\/(?:migration\/|dialect\/postgres\/postgres-introspector\.js$)/.test(source),
  );
  if (retained.length)
    throw new Error(`The MCP Worker must not upload migration or schema introspection code: ${retained.join(", ")}`);
}

export function checkMcpRuntimeBundle() {
  const path = fileURLToPath(new URL("../.upstream/apps/hosted/cloud/.generated/worker-uploads/mcp-server.json", import.meta.url));
  assertMcpRuntimeBundle(JSON.parse(readFileSync(path, "utf8")));
}
