import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigProvider, Effect } from "effect";
import { optionalConnectorClients } from "./environment.ts";
import { catalogSourceEvidence } from "./catalog-oauth-evidence.ts";
import { committedOAuthMetadata } from "./catalog-oauth-metadata.ts";
import {
  oauthFitness,
  oauthMethods,
  oauthPinProblems,
  oauthReviews,
} from "../src/catalog/oauth-policy.ts";

// The default reads only this commit, so the result can't change while the commit doesn't.
// `--live` also composes today's published catalog; the scheduled drift workflow runs it.
const { values } = parseArgs({
  options: { live: { type: "boolean", default: false }, catalog: { type: "string" } },
});
const directory = resolve(
  values.catalog ?? fileURLToPath(new URL("../src/catalog", import.meta.url)),
);
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
const reviews = oauthReviews(
  JSON.parse(readFileSync(join(directory, "oauth-reviews.json"), "utf8")),
);
const evidence = {
  hostedClients: new Set(clients.map((client) => client.id)),
  ...committedOAuthMetadata(reviews, directory),
};
let problems: string[];
let catalog: { entries: number; methods: number } | undefined;
if (values.live) {
  const { feed, sources, failures } = await catalogSourceEvidence(reviews);
  problems = [...failures, ...oauthFitness(feed, reviews, { ...evidence, sources })];
  catalog = {
    entries: feed.apps.filter((entry) => oauthMethods(entry).length > 0).length,
    methods: feed.apps.reduce((count, entry) => count + oauthMethods(entry).length, 0),
  };
} else problems = oauthPinProblems(reviews, evidence);
const summary = {
  mode: values.live ? "live catalog" : "committed",
  ...catalog,
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
