import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMcpRuntimeBundle, checkMcpRuntimeBundle } from "../mcp-runtime-bundle.ts";

test("the production MCP upload contains no migration, OAuth server or auth database engine", () => {
  checkMcpRuntimeBundle();
});

test("the MCP boundary rejects a retained migrator or introspector, regardless of its size", () => {
  for (const source of [
    "packages/sdk/src/implementation/storage.ts",
    "packages/sdk/src/implementation/storage-migrations.ts",
    "packages/app-registry/src/implementation/storage.ts",
    "packages/fumadb-effect/src/implementation/migration/migrator.ts",
    "packages/fumadb-effect/src/implementation/sql/migrator.ts",
    "packages/fumadb-effect/src/implementation/sql/introspect.ts",
    "node_modules/.bun/kysely@0.29.6/node_modules/kysely/dist/dialect/postgres/postgres-introspector.js",
    "node_modules/.bun/kysely@0.29.6/node_modules/kysely/dist/migration/migrator.js",
  ]) {
    assert.throws(
      () => assertMcpRuntimeBundle({ worker: "mcp-server", sources: { [source]: 1 } }),
      /must not upload migration or schema introspection code/,
    );
  }
});

test("the MCP boundary refuses an absent attribution or a different Worker", () => {
  assert.throws(() => assertMcpRuntimeBundle({ worker: "mcp-server", sources: {} }));
  assert.throws(() => assertMcpRuntimeBundle({ worker: "api", sources: { "entry.ts": 1 } }));
});

test("the MCP boundary rejects a duplicate OAuth server or auth database at any size", () => {
  for (const source of [
    "apps/hosted/cloud/src/infrastructure/mcp-auth.ts",
    "apps/hosted/cloud/src/infrastructure/auth-database.ts",
    "node_modules/@better-auth/oauth-provider/dist/index.mjs",
    "node_modules/.bun/@better-auth+oauth-provider@1.7.5/node_modules/@better-auth/oauth-provider/dist/index.mjs",
  ]) {
    assert.throws(
      () => assertMcpRuntimeBundle({ worker: "mcp-server", sources: { [source]: 1 } }),
      /must not upload an OAuth server or auth database/,
    );
  }
});
