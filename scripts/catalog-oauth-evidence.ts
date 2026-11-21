import { brand } from "../brand.ts";
import { carriedSources, handleCatalog } from "../src/catalog/worker.ts";
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

const compose = async (official: unknown): Promise<Feed> => {
  const response = await handleCatalog(
    new Request(`https://${brand.host}/catalog/index.json`),
    async () => Response.json(official),
  );
  if (!response.ok) throw new Error("The composed catalog is unavailable");
  return response.json();
};

const listing = (id: string, packageName: string, methods: readonly string[]) => ({
  id,
  package: packageName,
  name: id,
  description: id,
  auth: methods.map((method) => ({ method, kind: "oauth2" })),
  icons: [],
  source: `apps/${id}.json`,
});

/**
 * The published index as the reviews last saw it: every reviewed entry with exactly its reviewed
 * methods, and every carried app without one, so carried code that adds a method is still seen.
 * Entries this revision adds itself come from the revision, never from the stand-in.
 */
async function reviewedIndex(reviews: readonly OAuthReview[]): Promise<Feed> {
  const added = new Set((await compose({ version: 1, apps: [] })).apps.map((entry) => entry.id));
  const reviewed = new Set(reviews.map((review) => review.entry));
  return {
    version: 1,
    apps: [
      ...reviews.map((review) =>
        listing(review.entry, review.package, Object.keys(review.methods)),
      ),
      ...Object.entries(carriedSources)
        .filter(([id]) => !reviewed.has(id))
        .map(([id, source]) => listing(id, source.package, [])),
    ].filter((entry) => !added.has(entry.id)),
  };
}

/**
 * Exercise the catalog's public handler, including this revision's carried app sources. Offline,
 * the reviewed index stands in for the published one and sources only the publisher serves keep
 * their pins: both are outside state the scheduled drift workflow checks.
 */
export async function catalogSourceEvidence(
  reviews: readonly OAuthReview[],
  { offline = false } = {},
) {
  const feed = await compose(
    offline
      ? await reviewedIndex(reviews)
      : await readCatalogJson("https://catalog.executor.sh/index.json"),
  );
  const sources = new Map<string, string>();
  const failures: string[] = [];
  const positiveClaims = new Map(
    reviews
      .filter((review) =>
        Object.values(review.methods).some((method) => method.kind !== "deferred"),
      )
      .map((review) => [review.entry, review.sourceSha256]),
  );
  await bounded(
    feed.apps.filter((entry) => positiveClaims.has(entry.id)),
    async (entry) => {
      let published = false;
      try {
        const source = await handleCatalog(
          new Request(`https://${brand.host}/catalog/apps/${encodeURIComponent(entry.id)}.json`),
          offline
            ? async () => {
                published = true;
                throw new Error("The offline check never contacts the publisher");
              }
            : fetch,
        );
        if (published) {
          sources.set(entry.id, positiveClaims.get(entry.id)!);
          return;
        }
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
