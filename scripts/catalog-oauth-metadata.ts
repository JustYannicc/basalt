import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthReview } from "../src/catalog/oauth-policy.ts";

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

/** JSON formatting is immaterial; source file contents and all declaration fields are retained. */
export const catalogDocumentSha256 = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export class CatalogEvidenceReadError extends Error {}

export const readCatalogJson = async (url: string): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new CatalogEvidenceReadError(
      error instanceof DOMException && error.name === "TimeoutError"
        ? "request timed out"
        : "request did not complete",
    );
  }
  if (!response.ok) throw new CatalogEvidenceReadError(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new CatalogEvidenceReadError(
      error instanceof SyntaxError ? "invalid JSON" : "response body did not complete",
    );
  }
};

/** The reviewed document sits beside the review registry, one file per entry. */
export const metadataSnapshotFile = (entry: string) => `${entry}.oauth-metadata.json`;

export const automaticDecisions = (reviews: readonly OAuthReview[]) =>
  reviews.flatMap((review) =>
    Object.entries(review.methods).flatMap(([method, decision]) =>
      decision.kind === "automatic" ? [{ entry: review.entry, method, ...decision }] : [],
    ),
  );

type MetadataEvidence = {
  metadata: Map<string, { sha256: string; document: unknown }>;
  metadataFailures: Map<string, string>;
};

/** Exactly one entry owns each document, so a re-pin rewrites exactly one snapshot. */
export function committedOAuthMetadata(
  reviews: readonly OAuthReview[],
  directory: string,
): MetadataEvidence {
  const owners = new Map<string, Set<string>>();
  const documents = new Map<string, Set<string>>();
  for (const { entry, metadata } of automaticDecisions(reviews)) {
    owners.set(metadata, (owners.get(metadata) ?? new Set()).add(entry));
    documents.set(entry, (documents.get(entry) ?? new Set()).add(metadata));
  }
  const evidence: MetadataEvidence = { metadata: new Map(), metadataFailures: new Map() };
  for (const [url, entries] of owners) {
    const [entry] = [...entries];
    const file = metadataSnapshotFile(entry!);
    if (entries.size > 1 || documents.get(entry!)!.size > 1)
      evidence.metadataFailures.set(url, "the document needs exactly one owning entry");
    else if (!existsSync(join(directory, file)))
      evidence.metadataFailures.set(url, `no committed snapshot ${file}`);
    else {
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(join(directory, file), "utf8"));
      } catch {
        evidence.metadataFailures.set(url, `committed snapshot ${file} is not valid JSON`);
        continue;
      }
      evidence.metadata.set(url, { sha256: catalogDocumentSha256(document), document });
    }
  }
  return evidence;
}

/** Today's published documents. Only the scheduled drift job reads these. */
export async function liveOAuthMetadata(urls: readonly string[]): Promise<MetadataEvidence> {
  const evidence: MetadataEvidence = { metadata: new Map(), metadataFailures: new Map() };
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      try {
        const document = await readCatalogJson(url);
        evidence.metadata.set(url, { sha256: catalogDocumentSha256(document), document });
      } catch (error) {
        evidence.metadataFailures.set(
          url,
          error instanceof CatalogEvidenceReadError ? error.message : "request did not complete",
        );
      }
    }),
  );
  return evidence;
}
