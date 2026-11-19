import { brand } from "../brand.ts";
import { handleCatalog } from "../src/catalog/worker.ts";
import type { OAuthReview } from "../src/catalog/oauth-policy.ts";
import type { Feed } from "../src/catalog/feed.ts";
import { catalogDocumentSha256, readCatalogJson } from "./catalog-oauth-metadata.ts";

const bounded = async <A>(items: readonly A[], run: (item: A) => Promise<void>) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
};

/** Exercise the catalog's public handler, including this revision's carried app sources. */
export async function catalogSourceEvidence(reviews: readonly OAuthReview[]) {
  const official = await readCatalogJson("https://catalog.executor.sh/index.json");
  const response = await handleCatalog(
    new Request(`https://${brand.host}/catalog/index.json`),
    async () => Response.json(official),
  );
  if (!response.ok) throw new Error("The composed catalog is unavailable");
  const feed: Feed = await response.json();
  const sources = new Map<string, string>();
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
  return { feed, sources, failures };
}
