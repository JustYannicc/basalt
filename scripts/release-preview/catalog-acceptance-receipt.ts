import { servedFrameworkVersion } from "../../framework-release.ts";
import { catalogAcceptanceApps } from "./catalog-acceptance-inventory.ts";
import { digest, identifier, record } from "./catalog-acceptance-source.ts";
import type { CatalogAcceptanceResult } from "./catalog-acceptance.ts";

function sameIds(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    value.every((id) => typeof id === "string" && expected.includes(id))
  );
}

export function requireSuccessfulCatalogAcceptance(
  value: unknown,
  candidateHead: string,
): asserts value is CatalogAcceptanceResult {
  const result = record(value);
  if (
    !/^[a-f0-9]{40}$/.test(candidateHead) ||
    result.version !== 1 ||
    result.mode !== "preview-cold" ||
    result.candidateHead !== candidateHead ||
    result.frameworkVersion !== servedFrameworkVersion ||
    result.inventorySha256 !== digest(JSON.stringify(catalogAcceptanceApps)) ||
    result.signIn !== true ||
    result.coldCacheWitness !== true ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 33
  )
    throw new Error("The real preview catalog acceptance is missing or incomplete");
  const ids: string[] = [];
  for (const [index, expected] of catalogAcceptanceApps.entries()) {
    const row = record(result.rows[index]);
    if (
      row.index !== index ||
      row.entry !== expected.entry ||
      row.package !== expected.package ||
      row.sourcePath !== expected.sourcePath ||
      row.candidateHead !== candidateHead ||
      !Array.isArray(row.originBindingIssues) ||
      row.originBindingIssues.length !== 0 ||
      row.outcome !== "success" ||
      row.failure !== null ||
      row.httpStatus !== 200 ||
      typeof row.expectedDocumentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.expectedDocumentSha256) ||
      row.observedDocumentSha256 !== row.expectedDocumentSha256 ||
      typeof row.expectedFilesSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.expectedFilesSha256) ||
      row.installedFilesSha256 !== row.expectedFilesSha256 ||
      typeof row.elapsedMs !== "number" ||
      !Number.isSafeInteger(row.elapsedMs) ||
      row.elapsedMs < 0
    )
      throw new Error(`Catalog acceptance failed for ${expected.entry}`);
    ids.push(identifier(row.appId));
    identifier(row.activeVersion);
  }
  const cleanup = record(result.cleanup);
  if (
    new Set(ids).size !== 33 ||
    !sameIds(cleanup.createdAppIds, ids) ||
    !sameIds(cleanup.deletedAppIds, ids) ||
    cleanup.verifiedAbsent !== true ||
    cleanup.signedOut !== true ||
    cleanup.uncertainMutation !== false
  )
    throw new Error("Catalog acceptance cleanup is incomplete or includes an unowned app");
}
