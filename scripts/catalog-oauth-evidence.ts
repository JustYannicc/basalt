import { createHash } from "node:crypto";
import { brand } from "../brand.ts";
import { handleCatalog } from "../src/catalog/worker.ts";
import { oauthMethods, type OAuthReview, type OAuthEvidence } from "../src/catalog/oauth-policy.ts";
import type { Feed } from "../src/catalog/feed.ts";

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

const read = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Catalog evidence request failed with HTTP ${response.status}`);
  return response.json();
};

const bounded = async <A>(items: readonly A[], run: (item: A) => Promise<void>) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
};

/** Exercise the catalog's public handler, including this revision's carried app sources. */
export async function catalogOAuthEvidence(
  reviews: readonly OAuthReview[],
  hostedClients: ReadonlySet<string>,
) {
  const official = await read("https://catalog.executor.sh/index.json");
  const response = await handleCatalog(
    new Request(`https://${brand.host}/catalog/index.json`),
    async () => Response.json(official),
  );
  if (!response.ok) throw new Error("The composed catalog is unavailable");
  const feed: Feed = await response.json();
  const sources = new Map<string, string>();
  const metadata = new Map<string, { sha256: string; document: unknown }>();
  const failures: string[] = [];
  const positiveClaims = new Set(
    reviews
      .filter((review) =>
        Object.values(review.methods).some((method) => method.kind !== "deferred"),
      )
      .map((review) => review.entry),
  );
  await bounded(
    feed.apps.filter((entry) => positiveClaims.has(entry.id)),
    async (entry) => {
      try {
        const source = await handleCatalog(
          new Request(`https://${brand.host}/catalog/apps/${encodeURIComponent(entry.id)}.json`),
        );
        if (!source.ok) {
          failures.push(`${entry.id}: catalog source returned HTTP ${source.status}`);
          return;
        }
        sources.set(entry.id, catalogDocumentSha256(await source.json()));
      } catch {
        failures.push(`${entry.id}: published source request did not complete`);
      }
    },
  );
  const documents = [
    ...new Set(
      reviews.flatMap((review) =>
        Object.values(review.methods).flatMap((method) =>
          method.kind === "automatic" ? [method.metadata] : [],
        ),
      ),
    ),
  ];
  await bounded(documents, async (url) => {
    try {
      const document = await read(url);
      metadata.set(url, { sha256: catalogDocumentSha256(document), document });
    } catch {
      failures.push("A reviewed automatic OAuth metadata document could not be read");
    }
  });
  const evidence: OAuthEvidence = { sources, hostedClients, metadata };
  return { feed, evidence, failures };
}
