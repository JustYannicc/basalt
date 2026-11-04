import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { handleCatalog } from "./worker.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import {
  oauthFitness,
  oauthReviews,
  withOAuthDeferrals,
  type OAuthReview,
} from "./oauth-policy.ts";
import type { Feed } from "./feed.ts";

const sha = "a".repeat(64);

test("reviewed carried sources match the packages the catalog serves", async () => {
  const reviews = oauthReviews(reviewData);
  for (const id of ["atlassian", "aws", "elevenlabs", "gitlab", "gitlab-mcp", "miro", "slack", "vercel"]) {
    const response = await handleCatalog(
      new Request(`https://${brand.host}/catalog/apps/${id}.json`),
      async () => {
        throw new Error("A carried source must not contact its publisher");
      },
    );
    assert.equal(response.status, 200);
    assert.equal(
      catalogDocumentSha256(await response.json()),
      reviews.find((review) => review.entry === id)?.sourceSha256,
      id,
    );
  }
});

const entry = (id: string) => ({
  id,
  package: `@fixture/${id}`,
  name: id,
  description: "Fixture",
  auth: [
    { method: "oauth", kind: "oauth2" },
    { method: "key", kind: "secrets" },
  ],
  icons: [],
  source: `apps/${id}.json`,
});
const feed: Feed = { version: 1, apps: ["automatic", "hosted", "deferred"].map(entry) };
const reviews: readonly OAuthReview[] = [
  {
    entry: "automatic",
    package: "@fixture/automatic",
    sourceSha256: sha,
    methods: {
      oauth: {
        kind: "automatic",
        protocol: "dcr",
        metadata: "https://fixture.example/metadata",
        metadataSha256: sha,
      },
    },
  },
  {
    entry: "hosted",
    package: "@fixture/hosted",
    sourceSha256: sha,
    methods: {
      oauth: {
        kind: "hosted",
        client: "reviewed-client",
        message: "Shared sign-in is not configured here.",
      },
    },
  },
  {
    entry: "deferred",
    package: "@fixture/deferred",
    sourceSha256: sha,
    methods: {
      oauth: { kind: "deferred", message: "Use your own OAuth app for now." },
    },
  },
];
const evidence = () => ({
  sources: new Map(feed.apps.map((app) => [app.id, sha])),
  hostedClients: new Set(["reviewed-client"]),
  metadata: new Map<string, { sha256: string; document: unknown }>([
    [
      "https://fixture.example/metadata",
      {
        sha256: sha,
        document: {
          issuer: "https://fixture.example",
          authorization_endpoint: "https://fixture.example/authorize",
          token_endpoint: "https://fixture.example/token",
          registration_endpoint: "https://fixture.example/register",
        },
      },
    ],
  ]),
});

test("each OAuth method needs an exact reviewed decision and the reviewed source", () => {
  assert.deepEqual(oauthFitness(feed, reviews, evidence()), []);
  assert.match(
    oauthFitness({ ...feed, apps: [...feed.apps, entry("new")] }, reviews, evidence()).join("\n"),
    /new: OAuth methods have no reviewed/,
  );
  const changedMethod = {
    ...feed.apps[0]!,
    auth: [...feed.apps[0]!.auth, { method: "other", kind: "oauth2" }],
  };
  assert.match(
    oauthFitness(
      { ...feed, apps: [changedMethod, ...feed.apps.slice(1)] },
      reviews,
      evidence(),
    ).join("\n"),
    /automatic\/other: OAuth method is unclassified/,
  );
  const changedSource = evidence();
  changedSource.sources.set("hosted", "b".repeat(64));
  const deferredSource = evidence();
  deferredSource.sources.delete("deferred");
  assert.deepEqual(oauthFitness(feed, reviews, deferredSource), []);
  assert.match(
    oauthFitness(feed, reviews, changedSource).join("\n"),
    /hosted: published source changed/,
  );
  assert.match(
    oauthFitness(
      { ...feed, apps: [{ ...feed.apps[0]!, package: "@other/automatic" }, ...feed.apps.slice(1)] },
      reviews,
      evidence(),
    ).join("\n"),
    /reviewed package changed/,
  );
});

test("a client reference or discover URL alone cannot establish automatic sign-in", () => {
  const missingClient = evidence();
  missingClient.hostedClients.clear();
  assert.match(
    oauthFitness(feed, reviews, missingClient).join("\n"),
    /hosted client reviewed-client is not defined/,
  );
  const missingMetadata = evidence();
  missingMetadata.metadata.clear();
  assert.match(
    oauthFitness(feed, reviews, missingMetadata).join("\n"),
    /automatic client metadata is missing or changed/,
  );
  const changedMetadata = evidence();
  changedMetadata.metadata.set("https://fixture.example/metadata", {
    sha256: "b".repeat(64),
    document: {},
  });
  assert.match(
    oauthFitness(feed, reviews, changedMetadata).join("\n"),
    /automatic client metadata is missing or changed/,
  );
  const cimd: readonly OAuthReview[] = [
    {
      ...reviews[0]!,
      methods: {
        oauth: {
          kind: "automatic",
          protocol: "cimd",
          metadata: "https://fixture.example/metadata",
          metadataSha256: sha,
        },
      },
    },
  ];
  assert.match(
    oauthFitness({ ...feed, apps: [feed.apps[0]!] }, cimd, evidence()).join("\n"),
    /automatic client metadata/,
  );
  const supported = evidence();
  supported.metadata.set("https://fixture.example/metadata", {
    sha256: sha,
    document: {
      issuer: "https://fixture.example",
      authorization_endpoint: "https://fixture.example/authorize",
      token_endpoint: "https://fixture.example/token",
      registration_endpoint: "https://fixture.example/register",
      client_id_metadata_document_supported: true,
    },
  });
  assert.deepEqual(oauthFitness({ ...feed, apps: [feed.apps[0]!] }, cimd, supported), []);
});

test("wildcards, repeated entries and incomplete decisions cannot exempt an OAuth method", () => {
  assert.deepEqual(oauthReviews({ version: 1, entries: reviews }), reviews);
  for (const entries of [
    [...reviews, reviews[0]],
    [{ ...reviews[0], entry: "*" }],
    [{ ...reviews[0], package: "@fixture/*" }],
    [{ ...reviews[0], methods: { "*": { kind: "deferred", message: "Later" } } }],
    [{ ...reviews[0], methods: { oauth: { kind: "deferred", message: "" } } }],
    [{ ...reviews[0], methods: { oauth: { kind: "automatic", protocol: "dcr" } } }],
  ])
    assert.throws(() => oauthReviews({ version: 1, entries }));
  assert.match(
    oauthFitness({ ...feed, apps: feed.apps.slice(1) }, reviews, evidence()).join("\n"),
    /reviewed OAuth entry no longer exists/,
  );
});

test("connection guidance leaves source, auth choices and catalog descriptions intact", () => {
  const result = withOAuthDeferrals(feed, reviews);
  assert.equal(result.apps[0]!.oauthDeferrals, undefined);
  assert.deepEqual(result.apps[1]!.oauthDeferrals, [
    { method: "oauth", message: "Shared sign-in is not configured here." },
  ]);
  assert.deepEqual(result.apps[2]!.oauthDeferrals, [
    { method: "oauth", message: "Use your own OAuth app for now." },
  ]);
  for (let index = 0; index < feed.apps.length; index++) {
    assert.equal(result.apps[index]!.description, feed.apps[index]!.description);
    assert.equal(result.apps[index]!.auth, feed.apps[index]!.auth);
    assert.equal(result.apps[index]!.source, feed.apps[index]!.source);
    assert.equal(result.apps[index]!.connectionNotices, undefined);
  }
  const unrelated = withOAuthDeferrals(
    { version: 1, apps: [{ ...entry("deferred"), package: "@unrelated/deferred" }] },
    reviews,
  );
  assert.equal(unrelated.apps[0]!.oauthDeferrals, undefined);
});

test("the public catalog supplies Spotify's explicit deferral without a listing notice", async () => {
  const spotify = { ...entry("spotify"), package: "@executor.sh/spotify", name: "Spotify" };
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [spotify] }),
  );
  assert.equal(response.status, 200);
  const result = ((await response.json()) as Feed).apps.find((app) => app.id === "spotify")!;
  assert.deepEqual(result.oauthDeferrals, [
    {
      method: "oauth",
      message:
        "Spotify only allows a few test users for new apps, so for now you connect it with your own Spotify developer app.",
    },
  ]);
  assert.equal(result.connectionNotices, undefined);
  assert.equal(result.description, spotify.description);
  assert.deepEqual(result.auth, spotify.auth);
});

test("the public catalog preserves service aliases and exact-method OAuth guidance together", async () => {
  const confluence = {
    ...entry("confluence"),
    package: "@executor.sh/confluence",
    name: "Confluence",
    auth: [
      { method: "OAuth2", kind: "oauth2" },
      { method: "token", kind: "secrets" },
    ],
  };
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [confluence] }),
  );
  assert.equal(response.status, 200);
  const result = ((await response.json()) as Feed).apps.find((app) => app.id === "confluence")!;
  assert.deepEqual(result.service, {
    id: "atlassian",
    mcp: [],
    packages: ["@executor.sh/confluence", "atlassian"],
  });
  assert.deepEqual(result.oauthDeferrals, [
    {
      method: "OAuth2",
      message:
        "Signalbox has not verified one-click sign-in for Confluence yet. You can connect with your own OAuth app.",
    },
  ]);
  assert.deepEqual(result.auth, confluence.auth);
  assert.equal(result.description, confluence.description);
  assert.equal(result.source, confluence.source);
  assert.equal(result.connectionNotices, undefined);
});

test("the public catalog keeps Vercel sign-in beside exact-method connection guidance", async () => {
  const spotify = { ...entry("spotify"), package: "@executor.sh/spotify", name: "Spotify" };
  const vercel = {
    ...entry("vercel"),
    package: "@executor.sh/vercel",
    name: "Vercel",
    auth: [{ method: "apiKey", kind: "secrets", label: "Access token" }],
  };
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [spotify, vercel] }),
  );
  assert.equal(response.status, 200);
  const feed = (await response.json()) as Feed;
  const signedIn = feed.apps.find((app) => app.id === "vercel")!;
  assert.deepEqual(signedIn.auth, [
    { method: "oauth", kind: "oauth2", label: "Sign in with Vercel" },
    ...vercel.auth,
  ]);
  assert.equal(signedIn.oauthDeferrals, undefined);
  assert.deepEqual(signedIn.service?.mcp, ["https://mcp.vercel.com/"]);
  assert.equal(feed.apps.find((app) => app.id === "spotify")?.oauthDeferrals?.[0]?.method, "oauth");
});

test("GitLab MCP declares manual client setup while keeping its OAuth method available", async () => {
  const review = oauthReviews(reviewData).find((item) => item.entry === "gitlab-mcp");
  assert.ok(review);
  assert.equal(review.methods.oauth?.kind, "deferred");
  assert.ok(review.sourceSha256);
  const response = await handleCatalog(new Request(`https://${brand.host}/catalog/apps/gitlab-mcp.json`));
  assert.equal(response.status, 200);
  assert.equal(catalogDocumentSha256(await response.json()), review.sourceSha256);
});
