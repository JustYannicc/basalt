import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import { oauthReviews } from "./oauth-policy.ts";
import { cloudflareOAuthScopes } from "../pool/provider-accounts/cloudflare-scopes.ts";
import { metadataSnapshotFile } from "../../scripts/catalog-oauth-metadata.ts";
import {
  metadataIssuer,
  scopeBaselineFile,
  wholeListDecisions,
  wholeListIssuers,
} from "../../scripts/oauth-whole-list-issuers-source.ts";

/**
 * Connections whose requested scopes are the issuer's whole published list. Each must be marked
 * `scopeRequest: "issuer-list"` in the review registry, and each marked entry must be listed here.
 */
const mirrored: Readonly<Record<string, readonly string[]>> = {
  cloudflare: cloudflareOAuthScopes,
};

const reviews = oauthReviews(reviewData);
const reviewed = () =>
  (
    JSON.parse(
      readFileSync(new URL(metadataSnapshotFile("cloudflare"), import.meta.url), "utf8"),
    ) as { scopes_supported: string[] }
  ).scopes_supported.length;
const marked = reviews.flatMap((review) =>
  Object.values(review.methods).flatMap((decision) =>
    decision.kind === "automatic" && decision.scopeRequest === "issuer-list"
      ? [{ entry: review.entry, metadata: decision.metadata }]
      : [],
  ),
);

test("a whole-list mark and a connection that mirrors its issuer's scopes always go together", () => {
  assert.deepEqual(marked.map((item) => item.entry).sort(), Object.keys(mirrored).sort());
  for (const { entry, metadata } of marked) {
    const snapshot = JSON.parse(
      readFileSync(new URL(metadataSnapshotFile(entry), import.meta.url), "utf8"),
    ) as { issuer: string; scopes_supported: readonly string[] };
    assert.deepEqual(mirrored[entry], snapshot.scopes_supported, entry);
    // The SDK matches a grant by this issuer, so the reviewed URL must name the snapshot's issuer.
    assert.equal(metadataIssuer(metadata), snapshot.issuer, entry);
  }
  const catalog = fileURLToPath(new URL(".", import.meta.url));
  for (const { entry } of marked)
    assert.ok(existsSync(new URL(scopeBaselineFile(entry), import.meta.url)), `${entry} baseline`);
  assert.deepEqual(
    wholeListIssuers(catalog, reviews).map(({ issuer, scopes, baseline }) => ({
      issuer,
      scopes: scopes.length,
      baseline: baseline.length,
    })),
    [{ issuer: "https://mcp.cloudflare.com", scopes: reviewed(), baseline: 403 }],
  );
});

test("Cloudflare's scope baseline is the list grants asked for before they recorded it", () => {
  // Never regenerate it: grants saved before carry 0782 are recognized by exactly these scopes.
  const bytes = readFileSync(new URL(scopeBaselineFile("cloudflare"), import.meta.url));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "4245313f1e994e0f78313993ba82b5cf9f4ec56904dea9f114e1d826f6c319a1",
  );
  const baseline = JSON.parse(bytes.toString("utf8")) as string[];
  assert.equal(baseline.length, 403);
  for (const scope of ["offline_access", "account-api-tokens.write", "zone.write"])
    assert.ok(baseline.includes(scope), scope);
  assert.ok(!baseline.includes("billing:read"));
});

test("the registry accepts only the reviewed whole-list value", () => {
  const entry = (scopeRequest: unknown) => ({
    version: 1,
    entries: [
      {
        entry: "example",
        package: "@example/app",
        methods: {
          oauth: {
            kind: "automatic",
            protocol: "cimd",
            metadata: "https://auth.example.test/.well-known/oauth-authorization-server",
            metadataSha256: "a".repeat(64),
            scopeRequest,
          },
        },
        sourceSha256: "b".repeat(64),
      },
    ],
  });
  assert.deepEqual(wholeListDecisions(oauthReviews(entry("issuer-list"))), [
    { entry: "example", issuer: "https://auth.example.test" },
  ]);
  assert.deepEqual(wholeListDecisions(oauthReviews(entry(undefined))), []);
  assert.throws(() => oauthReviews(entry("everything")), /Unclassified OAuth method/);
  assert.throws(
    () => metadataIssuer("https://auth.example.test/.well-known/openid-configuration"),
    /not an RFC 8414/,
  );
  assert.equal(
    metadataIssuer("https://auth.example.test/.well-known/oauth-authorization-server/tenant"),
    "https://auth.example.test/tenant",
  );
  assert.throws(
    () => metadataIssuer("https://auth.example.test/.well-known/oauth-authorization-serverX"),
    /not an RFC 8414/,
  );
});

test("two marks for one issuer, however it is spelled, are refused", () => {
  const catalog = mkdtempSync(join(tmpdir(), "basalt-whole-list-"));
  try {
    const entries = ["one", "two"].map((entry, index) => {
      writeFileSync(
        join(catalog, `${entry}.oauth-metadata.json`),
        JSON.stringify({ issuer: "https://auth.example.test", scopes_supported: ["read"] }),
      );
      writeFileSync(join(catalog, `${entry}.oauth-scope-baseline.json`), JSON.stringify(["read"]));
      return {
        entry,
        package: `@example/${entry}`,
        methods: {
          oauth: {
            kind: "automatic",
            protocol: "cimd",
            metadata: `https://auth.example.test/.well-known/oauth-authorization-server${index ? "/" : ""}`,
            metadataSha256: "a".repeat(64),
            scopeRequest: "issuer-list",
          },
        },
        sourceSha256: "b".repeat(64),
      };
    });
    assert.throws(
      () => wholeListIssuers(catalog, oauthReviews({ version: 1, entries })),
      /marked by more than one reviewed connection/,
    );
    assert.equal(
      wholeListIssuers(catalog, oauthReviews({ version: 1, entries: entries.slice(0, 1) })).length,
      1,
    );
    rmSync(join(catalog, "one.oauth-scope-baseline.json"));
    assert.throws(
      () => wholeListIssuers(catalog, oauthReviews({ version: 1, entries: entries.slice(0, 1) })),
      /is marked but has no one\.oauth-scope-baseline\.json/,
    );
  } finally {
    rmSync(catalog, { recursive: true, force: true });
  }
});
