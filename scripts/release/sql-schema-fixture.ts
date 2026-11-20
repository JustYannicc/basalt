import { sqlSchemaNamespaces, type SqlSchemaReceipt } from "./sql-schema-contract.ts";

export function readySqlSchemas(
  candidate: string,
  imageDigest = `sha256:${"a".repeat(64)}`,
): SqlSchemaReceipt {
  return {
    formatVersion: 1,
    candidate,
    scope: "six-schema-namespaces",
    homeImageDigest: imageDigest,
    observations: sqlSchemaNamespaces.map((namespace) => ({
      namespace,
      database: namespace === "home" || namespace === "model-history" ? "pool" : "tools",
      journal: `fixture_${namespace}`,
      expected: [namespace === "home" ? "1" : "fixture_v1"],
      applied: [namespace === "home" ? "1" : "fixture_v1"],
      pending: [],
      unexpected: [],
      status: "ready",
      observedAt: "2026-01-01T00:00:00.000Z",
    })),
    home: {
      imageDigest,
      targetVersion: 1,
      expectedIndexes: [],
      readyIndexes: [],
      pendingIndexes: [],
      status: "ready",
      observedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
