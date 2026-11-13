import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogOAuthEvidence, catalogDocumentSha256 } from "./catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews } from "../src/catalog/oauth-policy.ts";
import reviewData from "../src/catalog/oauth-reviews.json" with { type: "json" };
import metadata from "../src/catalog/elevenlabs.oauth-metadata.json" with { type: "json" };

const review = oauthReviews(reviewData).find((item) => item.entry === "elevenlabs")!;
const method = review.methods.oauth!;
if (method.kind !== "automatic") throw new Error("Expected automatic ElevenLabs metadata");
const metadataUrl = method.metadata;
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

for (const failure of [
  "timeout",
  "network",
  "HTTP 503",
  "HTTP 429",
  "HTTP 404",
  "invalid JSON",
  "incomplete body",
]) {
  test(`unavailable metadata fails closed without claiming drift: ${failure}`, async (t) => {
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === "https://catalog.executor.sh/index.json") return Response.json(official);
      assert.equal(url, metadataUrl);
      if (failure === "timeout") throw new DOMException("fixture", "TimeoutError");
      if (failure === "network") throw new TypeError("fixture transport failure");
      if (failure === "invalid JSON") return new Response("{", { status: 200 });
      if (failure === "incomplete body")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("fixture body failure"));
            },
          }),
        );
      return new Response(null, { status: Number(failure.slice(5)) });
    });
    const result = await catalogOAuthEvidence([review], new Set());
    const feed = {
      ...result.feed,
      apps: result.feed.apps.filter((app) => app.id === review.entry),
    };
    const problems = [...result.failures, ...oauthFitness(feed, [review], result.evidence)];
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /elevenlabs\/oauth: automatic client metadata is unavailable/);
    assert.ok(problems[0]!.includes(metadataUrl));
    assert.doesNotMatch(problems.join("\n"), /changed|fixture/);
    if (failure === "incomplete body") assert.match(problems[0]!, /response body did not complete/);
    if (failure.startsWith("HTTP") || failure === "invalid JSON")
      assert.ok(problems[0]!.includes(failure));
  });
}

test("a fetched metadata change fails without accepting a later matching response", async (t) => {
  const changed = { ...metadata, issuer: "https://unreviewed.example" };
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "https://catalog.executor.sh/index.json") return Response.json(official);
    assert.equal(url, metadataUrl);
    return Response.json(reads++ === 0 ? changed : metadata);
  });
  const result = await catalogOAuthEvidence([review], new Set());
  const feed = { ...result.feed, apps: result.feed.apps.filter((app) => app.id === review.entry) };
  const problems = [...result.failures, ...oauthFitness(feed, [review], result.evidence)];
  assert.equal(reads, 1);
  assert.deepEqual(problems, [
    `elevenlabs/oauth: automatic client metadata changed (metadataSha256: ${method.metadataSha256} -> ${catalogDocumentSha256(changed)})`,
  ]);
});

test("a complete matching document verifies through the evidence collector", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "https://catalog.executor.sh/index.json") return Response.json(official);
    assert.equal(url, metadataUrl);
    return Response.json(metadata);
  });
  const result = await catalogOAuthEvidence([review], new Set());
  const feed = { ...result.feed, apps: result.feed.apps.filter((app) => app.id === review.entry) };
  assert.deepEqual([...result.failures, ...oauthFitness(feed, [review], result.evidence)], []);
});
