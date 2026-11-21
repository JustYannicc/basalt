import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogSourceEvidence } from "./catalog-oauth-evidence.ts";
import { committedOAuthMetadata } from "./catalog-oauth-metadata.ts";
import { oauthFitness, oauthReviews } from "../src/catalog/oauth-policy.ts";
import reviewData from "../src/catalog/oauth-reviews.json" with { type: "json" };

const reviews = oauthReviews(reviewData);
const review = reviews.find((item) => item.entry === "elevenlabs")!;
const official = {
  version: 1,
  apps: [
    {
      id: review.entry,
      package: review.package,
      name: "ElevenLabs",
      description: "AI audio",
      auth: [{ method: "key", kind: "secrets" }],
      icons: [],
      source: "apps/elevenlabs.json",
    },
  ],
};

test("the live catalog check composes the published index with this revision's sources", async (t) => {
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    reads.push(url);
    return Response.json(official);
  });
  const { feed, sources, failures } = await catalogSourceEvidence([review]);
  assert.deepEqual(reads, ["https://catalog.executor.sh/index.json"]);
  assert.deepEqual(failures, []);
  const apps = feed.apps.filter((app) => app.id === review.entry);
  const evidence = {
    sources,
    hostedClients: new Set<string>(),
    ...committedOAuthMetadata(reviews, fileURLToPath(new URL("../src/catalog", import.meta.url))),
  };
  assert.deepEqual(oauthFitness({ ...feed, apps }, [review], evidence), []);
  sources.set(review.entry, "0".repeat(64));
  assert.deepEqual(oauthFitness({ ...feed, apps }, [review], evidence), [
    "elevenlabs: published source changed or could not be verified",
  ]);
});
