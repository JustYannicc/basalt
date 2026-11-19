import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
  catalogDocumentSha256,
  committedOAuthMetadata,
  liveOAuthMetadata,
} from "./catalog-oauth-metadata.ts";
import { oauthPinProblems, oauthReviews } from "../src/catalog/oauth-policy.ts";
import reviewData from "../src/catalog/oauth-reviews.json" with { type: "json" };
import metadata from "../src/catalog/elevenlabs.oauth-metadata.json" with { type: "json" };

const review = oauthReviews(reviewData).find((item) => item.entry === "elevenlabs")!;
const method = review.methods.oauth!;
if (method.kind !== "automatic") throw new Error("Expected automatic ElevenLabs metadata");
const metadataUrl = method.metadata;
const problems = async () =>
  oauthPinProblems([review], {
    hostedClients: new Set(),
    ...(await liveOAuthMetadata([metadataUrl])),
  });

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
    const found = await problems();
    assert.equal(found.length, 1);
    assert.match(found[0]!, /elevenlabs\/oauth: automatic client metadata is unavailable/);
    assert.ok(found[0]!.includes(metadataUrl));
    assert.doesNotMatch(found.join("\n"), /changed|fixture/);
    if (failure === "incomplete body") assert.match(found[0]!, /response body did not complete/);
    if (failure.startsWith("HTTP") || failure === "invalid JSON")
      assert.ok(found[0]!.includes(failure));
  });
}

test("a fetched metadata change fails without accepting a later matching response", async (t) => {
  const changed = { ...metadata, issuer: "https://unreviewed.example" };
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, metadataUrl);
    return Response.json(reads++ === 0 ? changed : metadata);
  });
  const found = oauthPinProblems([review], {
    hostedClients: new Set(),
    ...(await liveOAuthMetadata([metadataUrl, metadataUrl])),
  });
  assert.equal(reads, 1);
  assert.deepEqual(found, [
    `elevenlabs/oauth: automatic client metadata changed (metadataSha256: ${method.metadataSha256} -> ${catalogDocumentSha256(changed)})`,
  ]);
});

test("a complete matching published document verifies against the reviewed pin", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, metadataUrl);
    return Response.json(metadata);
  });
  assert.deepEqual(await problems(), []);
});

test("a snapshot is read only for a document exactly one entry owns", () => {
  const decision = (url: string) =>
    ({
      kind: "automatic",
      protocol: "dcr",
      metadata: url,
      metadataSha256: "a".repeat(64),
    }) as const;
  const [first, second] = ["https://one.example/metadata", "https://two.example/metadata"];
  const shared = committedOAuthMetadata(
    [
      { entry: "one", package: "@fixture/one", methods: { oauth: decision(first) } },
      { entry: "two", package: "@fixture/two", methods: { oauth: decision(first) } },
    ],
    tmpdir(),
  );
  assert.deepEqual(
    [...shared.metadataFailures],
    [[first, "reviewed by one, two; one entry owns it"]],
  );
  const several = committedOAuthMetadata(
    [
      {
        entry: "one",
        package: "@fixture/one",
        methods: { a: decision(first), b: decision(second) },
      },
    ],
    tmpdir(),
  );
  assert.deepEqual(
    [...several.metadataFailures],
    [first, second].map((url) => [url, "one names several documents; one snapshot per entry"]),
  );
  assert.equal(shared.metadata.size + several.metadata.size, 0);
});
