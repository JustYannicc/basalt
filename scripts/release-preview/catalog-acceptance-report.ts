import { appendFile, readFile } from "node:fs/promises";
import { catalogAcceptanceApps } from "./catalog-acceptance-inventory.ts";
import { requireSuccessfulCatalogAcceptance } from "./catalog-acceptance-receipt.ts";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: unknown, length = 64) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
    ? value
    : "missing-or-invalid";
const reasons = new Set([
  "BuildBusy",
  "RuntimeBuildFailed",
  "StorageError",
  "RequestInvalid",
  "BuildMemoryExceeded",
  "CatalogImportFailed",
  "install-refused",
  "cold-cache-witness-missing",
  "public-source-binding-mismatch",
  "installed-source-binding-mismatch",
  "installed-origin-binding-mismatch",
  "required-catalog-entry-missing-or-duplicated",
  "installer-reused-an-app",
  "installer-returned-existing-id",
  "acceptance-request-or-validation-failed",
  "acceptance-failed",
]);

/** Only fixed inventory names, bounded categories and validated digests may leave private logs. */
export function catalogAcceptanceFailures(value: unknown, head: string) {
  const result = object(value);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const failures: string[] = [];
  if (result.candidateHead !== head)
    failures.push(
      `candidate head expected ${hash(head, 40)}, observed ${hash(result.candidateHead, 40)}`,
    );
  for (const [index, app] of catalogAcceptanceApps.entries()) {
    const row = object(rows[index]);
    const details: string[] = [];
    if (row.entry !== app.entry || row.package !== app.package)
      details.push("inventory identity missing or changed");
    if (row.outcome !== "success")
      details.push(
        `install ${typeof row.failure === "string" && reasons.has(row.failure) ? row.failure : "failed-or-not-run"}`,
      );
    if (row.expectedDocumentSha256 !== row.observedDocumentSha256)
      details.push(
        `source document expected ${hash(row.expectedDocumentSha256)}, observed ${hash(row.observedDocumentSha256)}`,
      );
    if (row.installedFilesSha256 !== null && row.expectedFilesSha256 !== row.installedFilesSha256)
      details.push(
        `installed files expected ${hash(row.expectedFilesSha256)}, observed ${hash(row.installedFilesSha256)}`,
      );
    const properties = new Set([
      "copiedFrom.name",
      "copiedFrom.reference",
      "copiedFrom.commit",
      "service.newInstance",
    ]);
    for (const value of Array.isArray(row.originBindingIssues) ? row.originBindingIssues : []) {
      const issue = object(value);
      if (typeof issue.property === "string" && properties.has(issue.property))
        details.push(
          `${issue.property} expected SHA256 ${hash(issue.expectedSha256)}, observed SHA256 ${hash(issue.observedSha256)}`,
        );
    }
    if (
      typeof row.httpStatus === "number" &&
      Number.isInteger(row.httpStatus) &&
      row.httpStatus >= 100 &&
      row.httpStatus <= 599 &&
      row.httpStatus !== 200
    )
      details.push(`install HTTP status expected 200, observed ${row.httpStatus}`);
    if (details.length) failures.push(`${app.entry}: ${details.join("; ")}`);
  }
  const cleanup = object(result.cleanup);
  const created = Array.isArray(cleanup.createdAppIds) ? cleanup.createdAppIds : [];
  const deleted = Array.isArray(cleanup.deletedAppIds) ? cleanup.deletedAppIds : [];
  for (const [index, app] of catalogAcceptanceApps.entries()) {
    const id = object(rows[index]).appId;
    if (typeof id === "string" && created.includes(id) && !deleted.includes(id))
      failures.push(`${app.entry}: owned app deletion was not confirmed`);
  }
  for (const field of ["verifiedAbsent", "signedOut"])
    if (cleanup[field] !== true)
      failures.push(
        `cleanup.${field}: expected true, observed ${cleanup[field] === false ? "false" : "missing-or-invalid"}`,
      );
  if (cleanup.uncertainMutation !== false)
    failures.push("cleanup.uncertainMutation: expected false; mutation outcome is uncertain");
  return failures;
}

/** Read the checkpoint even when the private child fails, before full-stage teardown runs. */
export async function catalogAcceptanceOperation(
  operation: () => Promise<void>,
  resultPath: string,
  head: string,
  options: { summaryPath?: string; emit?: (message: string) => void } = {},
) {
  let failed = false;
  try {
    await operation();
  } catch {
    failed = true;
  }
  let result: unknown;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    failed = true;
  }
  try {
    requireSuccessfulCatalogAcceptance(result, head);
  } catch {
    failed = true;
  }
  if (failed) {
    const failures = catalogAcceptanceFailures(result, head);
    if (!failures.length)
      failures.push(
        "catalog result failed its complete receipt contract or the private operation failed",
      );
    for (const failure of failures)
      (options.emit ?? console.error)(`::error::Catalog compiler acceptance: ${failure}`);
    if (options.summaryPath)
      await appendFile(
        options.summaryPath,
        `\n### Catalog compiler acceptance failed\n\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`,
      );
    throw new Error("Catalog compiler acceptance failed; safe details are in the job summary");
  }
  return result;
}
