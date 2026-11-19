import { appendFileSync, writeFileSync } from "node:fs";
import { ConfigProvider, Effect } from "effect";
import { optionalConnectorClients } from "./environment.ts";
import {
  CatalogSourceUnavailable,
  catalogOAuthEvidence,
  catalogOAuthVerdict,
} from "./catalog-oauth-evidence.ts";
import { oauthFitness, oauthMethods, oauthReviews } from "../src/catalog/oauth-policy.ts";
import type { Feed } from "../src/catalog/feed.ts";
import reviewData from "../src/catalog/oauth-reviews.json" with { type: "json" };

const { firstPartyOAuthClients } = await import(
  new URL(
    "../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts",
    import.meta.url,
  ).href
);

// Synthetic pairs load the host's actual reviewed definitions without reading deployment secrets.
const settings = Object.fromEntries(
  optionalConnectorClients.flatMap((client) => [
    [client.id, "catalog-fitness-client"],
    [client.secret, "catalog-fitness-secret"],
  ]),
);
const clients: readonly { id: string }[] = await Effect.runPromise(
  firstPartyOAuthClients({ testDefinitions: false }).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(settings)),
  ),
);
const reviews = oauthReviews(reviewData);
const unavailable: string[] = [];
let feed: Feed | undefined;
let problems: string[] = [];
try {
  const collected = await catalogOAuthEvidence(
    reviews,
    new Set(clients.map((client) => client.id)),
  );
  feed = collected.feed;
  problems = oauthFitness(collected.feed, reviews, collected.evidence, unavailable);
} catch (error) {
  // Without the index nothing else can be checked, which is an outage rather than drift.
  if (!(error instanceof CatalogSourceUnavailable)) throw error;
  unavailable.push(error.message);
}
const verdict = catalogOAuthVerdict(problems, unavailable, process.env.CATALOG_SOURCES_REQUIRED);
const apps = feed?.apps ?? [];
const summary = {
  entries: apps.filter((entry) => oauthMethods(entry).length > 0).length,
  methods: apps.reduce((count, entry) => count + oauthMethods(entry).length, 0),
  decisions: reviews
    .flatMap((review) => Object.values(review.methods))
    .reduce<Record<string, number>>(
      (counts, decision) => ({ ...counts, [decision.kind]: (counts[decision.kind] ?? 0) + 1 }),
      {},
    ),
  sourcesRequired: verdict.required,
  problems,
  unavailable,
};
const report = JSON.stringify(summary, null, 2);
if (process.env.CATALOG_OAUTH_REPORT)
  writeFileSync(process.env.CATALOG_OAUTH_REPORT, report + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    "## Catalog OAuth connection paths\n\n```json\n" +
      report +
      "\n```\n" +
      (verdict.warnings.length > 0
        ? `\n${verdict.warnings.length} catalog source(s) could not be fetched after retries. Not required on a pull request's fast lane; the batch's full Check re-runs this step and fails on them before main.\n`
        : ""),
  );
console.log(report);
for (const warning of verdict.warnings)
  console.log(
    `::warning title=Catalog source unavailable::${warning.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`,
  );
if (verdict.failed) process.exitCode = 1;
