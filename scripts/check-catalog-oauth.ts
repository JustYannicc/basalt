import { appendFileSync, writeFileSync } from "node:fs";
import { ConfigProvider, Effect } from "effect";
import { optionalConnectorClients } from "./environment.ts";
import { catalogOAuthEvidence } from "./catalog-oauth-evidence.ts";
import { oauthFitness, oauthMethods, oauthReviews } from "../src/catalog/oauth-policy.ts";
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
const { feed, evidence, failures } = await catalogOAuthEvidence(
  reviews,
  new Set(clients.map((client) => client.id)),
);
const problems = [...failures, ...oauthFitness(feed, reviews, evidence)];
const summary = {
  entries: feed.apps.filter((entry) => oauthMethods(entry).length > 0).length,
  methods: feed.apps.reduce((count, entry) => count + oauthMethods(entry).length, 0),
  decisions: reviews
    .flatMap((review) => Object.values(review.methods))
    .reduce<Record<string, number>>(
      (counts, decision) => ({ ...counts, [decision.kind]: (counts[decision.kind] ?? 0) + 1 }),
      {},
    ),
  problems,
};
const report = JSON.stringify(summary, null, 2);
if (process.env.CATALOG_OAUTH_REPORT)
  writeFileSync(process.env.CATALOG_OAUTH_REPORT, report + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    "## Catalog OAuth connection paths\n\n```json\n" + report + "\n```\n",
  );
console.log(report);
if (problems.length > 0) process.exitCode = 1;
