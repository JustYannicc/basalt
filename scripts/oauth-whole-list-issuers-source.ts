import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oauthReviews, type OAuthReview } from "../src/catalog/oauth-policy.ts";
import { metadataSnapshotFile } from "./catalog-oauth-metadata.ts";

/** Where the SDK reads the issuers whose reviewed connections ask for their whole scope list. */
export const wholeListIssuersPath = "packages/sdk/src/implementation/oauth-whole-list-issuers.ts";

/**
 * The reviewed list a marked connection asked for before its grants recorded that they ask for
 * the whole list. Written once when an entry is marked and never regenerated: older grants are
 * recognized by it, so moving it would flag or release grants that were saved under it.
 */
export const scopeBaselineFile = (entry: string) => `${entry}.oauth-scope-baseline.json`;

/**
 * Digests of the lists a marked connection was reviewed with after its baseline, oldest first. A
 * re-pin that moves the snapshot appends the new list's digest (a catalog test requires today's
 * list to be the baseline or the last entry), and none is ever removed: a stored provider may still
 * ask for an earlier list after the issuer drops a scope.
 */
export const scopeHistoryFile = (entry: string) => `${entry}.oauth-scope-history.json`;

const wellKnown = "/.well-known/oauth-authorization-server";

/** The issuer a reviewed RFC 8414 metadata URL belongs to: the well-known segment removed. */
export const metadataIssuer = (metadata: string) => {
  const url = new URL(metadata);
  const suffix = url.pathname.slice(wellKnown.length);
  if (
    !url.pathname.startsWith(wellKnown) ||
    (suffix !== "" && !suffix.startsWith("/")) ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error(`${metadata} is not an RFC 8414 authorization server metadata URL`);
  return url.origin + suffix;
};

/** Every automatic decision the registry marks as asking for its issuer's whole list. */
export const wholeListDecisions = (reviews: readonly OAuthReview[]) =>
  reviews.flatMap((review) =>
    Object.values(review.methods).flatMap((decision) =>
      decision.kind === "automatic" && decision.scopeRequest === "issuer-list"
        ? [{ entry: review.entry, issuer: metadataIssuer(decision.metadata) }]
        : [],
    ),
  );

const names = (value: unknown, source: string) => {
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === "string"))
    throw new Error(`${source} must be a list of scope names`);
  return value as string[];
};
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const digests = (value: unknown, source: string) => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && /^\d+:[0-9a-f]{16}$/.test(item))
  )
    throw new Error(`${source} must be a list of scope list digests`);
  return value as string[];
};

/** Each marked issuer with its reviewed scope list today, its frozen baseline and its history. */
export function wholeListIssuers(catalog: string, reviews: readonly OAuthReview[]) {
  return wholeListDecisions(reviews)
    .map(({ entry, issuer }) => {
      const snapshot = join(catalog, metadataSnapshotFile(entry));
      const baseline = join(catalog, scopeBaselineFile(entry));
      // Without its baseline every older grant of the issuer would be held to every scope.
      if (!existsSync(baseline))
        throw new Error(`${entry} is marked but has no ${scopeBaselineFile(entry)}`);
      const history = join(catalog, scopeHistoryFile(entry));
      return {
        issuer,
        scopes: names(
          (json(snapshot) as { scopes_supported?: unknown }).scopes_supported,
          snapshot,
        ),
        baseline: names(json(baseline), baseline),
        history: existsSync(history) ? digests(json(history), history) : [],
      };
    })
    .sort((a, b) => new URL(a.issuer).href.localeCompare(new URL(b.issuer).href, "en"))
    .map((item, index, all) => {
      // The SDK matches issuers as URLs, so two spellings of one issuer are one issuer.
      if (index > 0 && new URL(all[index - 1]!.issuer).href === new URL(item.issuer).href)
        throw new Error(`${item.issuer} is marked by more than one reviewed connection`);
      return item;
    });
}

/**
 * The SDK's `scopeListDigest`, so the generated module carries one short name per reviewed list
 * instead of the list. An upstream test holds the generated names equal to the SDK's own.
 */
export const scopeListDigest = (scopes: readonly string[]) => {
  const names = [...new Set(scopes)].sort();
  const text = names.join("\n");
  let h1 = 0xdeadbeef ^ names.length;
  let h2 = 0x41c6ce57 ^ names.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  return `${names.length}:${hex(h2)}${hex(h1)}`;
};

export function wholeListIssuersSource(root: string) {
  const catalog = join(root, "src/catalog");
  const reviews = oauthReviews(
    JSON.parse(readFileSync(join(catalog, "oauth-reviews.json"), "utf8")),
  );
  return `// Generated by Basalt's upstream preparation from src/catalog/oauth-reviews.json.\nimport type { WholeListIssuer } from "./provider-oauth-scopes.ts";\n\nexport const wholeListScopeIssuers: readonly WholeListIssuer[] = ${JSON.stringify(
    wholeListIssuers(catalog, reviews).map(({ issuer, scopes, baseline, history }) => ({
      issuer,
      lists: [...new Set([scopeListDigest(baseline), ...history, scopeListDigest(scopes)])],
    })),
  )};\n`;
}
