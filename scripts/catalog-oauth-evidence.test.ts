import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CatalogSourceUnavailable,
  catalogDocumentSha256,
  catalogOAuthEvidence,
  catalogOAuthVerdict,
  type CatalogReadOptions,
} from "./catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews, type OAuthReview } from "../src/catalog/oauth-policy.ts";
import reviewData from "../src/catalog/oauth-reviews.json" with { type: "json" };
import metadata from "../src/catalog/elevenlabs.oauth-metadata.json" with { type: "json" };

const index = "https://catalog.executor.sh/index.json";
const review = oauthReviews(reviewData).find((item) => item.entry === "elevenlabs")!;
const method = review.methods.oauth!;
if (method.kind !== "automatic") throw new Error("Expected automatic ElevenLabs metadata");
const metadataUrl = method.metadata;

// A reviewed app whose source the publisher serves, unlike ElevenLabs' carried one.
const sourceUrl = "https://catalog.executor.sh/apps/published.json";
const sourceDocument = {
  package: "@fixture/published",
  files: [{ path: "index.ts", content: "export {};\n" }],
};
const published: OAuthReview = {
  entry: "published",
  package: "@fixture/published",
  sourceSha256: catalogDocumentSha256(sourceDocument),
  methods: { oauth: { kind: "hosted", client: "fixture-client", message: "Shared sign-in." } },
};
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
    {
      id: published.entry,
      package: published.package,
      name: "Published",
      description: "Fixture",
      auth: [{ method: "oauth", kind: "oauth2" }],
      icons: [],
      source: "apps/published.json",
    },
  ],
};

type Answer = (init?: RequestInit) => Response | Promise<Response>;
const status = (code: number) => () => new Response(null, { status: code });
const json = (value: unknown) => () => Response.json(value);

/** Serves the index, then each listed URL's answers in order, repeating the last. */
function publisher(routes: Record<string, Answer[]>) {
  const reads = new Map<string, number>();
  const signals: AbortSignal[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.signal) signals.push(init.signal);
    if (url === index) return Response.json(official);
    const answers = routes[url];
    assert.ok(answers, `unexpected read of ${url}`);
    const count = reads.get(url) ?? 0;
    reads.set(url, count + 1);
    return answers[Math.min(count, answers.length - 1)]!(init);
  };
  return { fetch, reads: (url: string) => reads.get(url) ?? 0, signals };
}

async function check(
  reviews: readonly OAuthReview[],
  fetch: CatalogReadOptions["fetch"],
  options: CatalogReadOptions = {},
) {
  const sleeps: number[] = [];
  const result = await catalogOAuthEvidence(reviews, new Set(["fixture-client"]), {
    fetch,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    log: () => undefined,
    ...options,
  });
  const ids = new Set(reviews.map((item) => item.entry));
  const feed = { ...result.feed, apps: result.feed.apps.filter((app) => ids.has(app.id)) };
  const unavailable: string[] = [];
  const problems = oauthFitness(feed, reviews, result.evidence, unavailable);
  return { problems, unavailable, sleeps };
}

for (const [failure, answer, reason, attempts] of [
  [
    "timeout",
    () => {
      throw new DOMException("fixture", "TimeoutError");
    },
    "request timed out after 3 attempts",
    3,
  ],
  [
    "network",
    () => {
      throw new TypeError("fixture transport failure");
    },
    "request did not complete after 3 attempts",
    3,
  ],
  ["HTTP 503", status(503), "HTTP 503 after 3 attempts", 3],
  ["HTTP 429", status(429), "HTTP 429 after 3 attempts", 3],
  [
    "incomplete body",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("fixture body failure"));
          },
        }),
      ),
    "response body did not complete after 3 attempts",
    3,
  ],
  ["HTTP 404", status(404), "HTTP 404", 1],
  ["invalid JSON", () => new Response("{", { status: 200 }), "invalid JSON", 1],
] as const) {
  test(`unavailable metadata is reported apart from drift: ${failure}`, async () => {
    const served = publisher({ [metadataUrl]: [answer] });
    const result = await check([review], served.fetch);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.unavailable, [
      `elevenlabs/oauth: automatic client metadata is unavailable (${metadataUrl}: ${reason})`,
    ]);
    assert.equal(served.reads(metadataUrl), attempts);
    assert.deepEqual(result.sleeps, [1000, 2000].slice(0, attempts - 1));
  });
}

test("a source answering 502 and then 200 verifies after one retry", async () => {
  const served = publisher({ [sourceUrl]: [status(502), json(sourceDocument)] });
  const result = await check([published], served.fetch);
  assert.deepEqual(result, { problems: [], unavailable: [], sleeps: [1000] });
  assert.equal(served.reads(sourceUrl), 2);
});

test("three 502s leave a source unavailable: failing when required, a warning when not", async () => {
  const served = publisher({ [sourceUrl]: [status(502)] });
  const { problems, unavailable, sleeps } = await check([published], served.fetch);
  assert.deepEqual(problems, []);
  assert.deepEqual(unavailable, [
    "published: published source is unavailable (HTTP 502 after 3 attempts)",
  ]);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(served.reads(sourceUrl), 3);
  assert.deepEqual(catalogOAuthVerdict(problems, unavailable, "true"), {
    required: true,
    failed: true,
    warnings: [],
  });
  assert.deepEqual(catalogOAuthVerdict(problems, unavailable, "false"), {
    required: false,
    failed: false,
    warnings: unavailable,
  });
});

test("a stalled read ends at its own per-try timeout and is retried", async () => {
  const stall: Answer = (init) =>
    new Promise((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
    );
  const served = publisher({ [sourceUrl]: [stall, json(sourceDocument)] });
  const result = await check([published], served.fetch, { attemptTimeoutMs: 20 });
  assert.deepEqual(result, { problems: [], unavailable: [], sleeps: [1000] });
  assert.equal(served.reads(sourceUrl), 2);
  const [first, second] = served.signals.slice(-2);
  assert.ok(first!.aborted);
  assert.notEqual(first, second);
});

test("a 404 is final without a retry", async () => {
  const served = publisher({ [sourceUrl]: [status(404), json(sourceDocument)] });
  const result = await check([published], served.fetch);
  assert.deepEqual(result, {
    problems: [],
    unavailable: ["published: published source is unavailable (HTTP 404)"],
    sleeps: [],
  });
  assert.equal(served.reads(sourceUrl), 1);
});

test("a fetched source that differs from its pin is changed and fails even when not required", async () => {
  const changed = { ...sourceDocument, files: [{ path: "index.ts", content: "export {1};\n" }] };
  const served = publisher({ [sourceUrl]: [json(changed)] });
  const { problems, unavailable } = await check([published], served.fetch);
  assert.deepEqual(problems, [
    `published: published source changed (sourceSha256: ${published.sourceSha256} -> ${catalogDocumentSha256(changed)})`,
  ]);
  assert.deepEqual(unavailable, []);
  assert.equal(catalogOAuthVerdict(problems, unavailable, "false").failed, true);
});

test("a missing or unrecognised required setting fails closed", () => {
  const unavailable = ["published: published source is unavailable (HTTP 502 after 3 attempts)"];
  for (const setting of [undefined, "", "true", "False", "0"])
    assert.deepEqual(catalogOAuthVerdict([], unavailable, setting), {
      required: true,
      failed: true,
      warnings: [],
    });
  assert.equal(catalogOAuthVerdict([], [], undefined).failed, false);
});

test("an unreachable index is unavailable rather than drift", async () => {
  await assert.rejects(
    catalogOAuthEvidence([review], new Set(), {
      fetch: async () => new Response(null, { status: 503 }),
      sleep: async () => undefined,
      log: () => undefined,
    }),
    (error) =>
      error instanceof CatalogSourceUnavailable &&
      error.message === `catalog index is unavailable (${index}: HTTP 503 after 3 attempts)`,
  );
});

test("a fetched metadata change fails without accepting a later matching response", async () => {
  const changed = { ...metadata, issuer: "https://unreviewed.example" };
  const served = publisher({ [metadataUrl]: [json(changed), json(metadata)] });
  const result = await check([review], served.fetch);
  assert.equal(served.reads(metadataUrl), 1);
  assert.deepEqual(result.problems, [
    `elevenlabs/oauth: automatic client metadata changed (metadataSha256: ${method.metadataSha256} -> ${catalogDocumentSha256(changed)})`,
  ]);
  assert.deepEqual(result.unavailable, []);
});

test("a complete matching document verifies through the evidence collector", async () => {
  const served = publisher({ [metadataUrl]: [json(metadata)] });
  const result = await check([review], served.fetch);
  assert.deepEqual(result, { problems: [], unavailable: [], sleeps: [] });
});
