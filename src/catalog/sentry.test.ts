import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import { onServedFramework } from "./framework.ts";
import { oauthFitness, oauthReviews, withOAuthDeferrals } from "./oauth-policy.ts";
import reviews from "./oauth-reviews.json" with { type: "json" };
import { sentrySource, withSentryConnections } from "./sentry.ts";
import { handleCatalog } from "./worker.ts";

const bytes = (suffix: string) => readFileSync(new URL(`./sentry.${suffix}`, import.meta.url));
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

test("Sentry source serves without the publisher and its patch replays exactly", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/sentry.json"),
    async () => {
      throw new Error("Publisher unavailable");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(sentrySource))),
  );
  const head = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/sentry.json", { method: "HEAD" }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const provenance = JSON.parse(bytes("provenance.json").toString());
  assert.equal(digest(bytes("published.json")), provenance.publishedSha256);
  assert.equal(digest(bytes("json")), provenance.carriedSha256);
  assert.equal(digest(bytes("patch")), provenance.patchSha256);
  const original: typeof sentrySource = JSON.parse(bytes("published.json").toString());
  const directory = mkdtempSync(join(tmpdir(), "sentry-replay-"));
  try {
    for (const file of original.files) writeFileSync(join(directory, file.path), file.content);
    execFileSync(
      "git",
      ["apply", "--unsafe-paths", new URL("./sentry.patch", import.meta.url).pathname],
      { cwd: directory },
    );
    for (const file of sentrySource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("Sentry's available OAuth claim is bound to the served source and DCR metadata", async () => {
  const official = {
    version: 1 as const,
    apps: [
      {
        id: "sentry",
        package: sentrySource.package,
        name: "Sentry",
        description: "Error tracking.",
        icons: [],
        source: "apps/sentry.json",
        auth: [
          { method: "oauth", kind: "oauth2" },
          { method: "authToken", kind: "secrets" },
        ],
      },
    ],
  };
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json(official),
  );
  const feed = await response.json();
  const entry = feed.apps.find((entry: { id: string }) => entry.id === "sentry");
  assert.equal(entry.oauthDeferrals, undefined);
  assert.equal(entry.toolSections[0].method, "authToken");
  assert.deepEqual(
    entry.auth.map((method: { label: string }) => method.label),
    ["Sign in for MCP tools", "Personal token for MCP and API"],
  );
  const readme = sentrySource.files.find((file) => file.path === "README.md")?.content;
  assert.ok(readme?.includes("A personal token supplies both `mcp` and `api` tools"));
  assert.ok(!readme?.includes("auth-token accounts have no MCP tools"));
  assert.deepEqual(
    entry.connectionGuidance.map((guide: { requirement: string; method: string }) => [
      guide.requirement,
      guide.method,
    ]),
    [
      ["sentry", "oauth"],
      ["sentry", "authToken"],
    ],
  );
  const review = oauthReviews(reviews).filter((entry) => entry.entry === "sentry");
  const metadata = JSON.parse(bytes("oauth-metadata.json").toString());
  const evidence = {
    sources: new Map([
      [
        "sentry",
        catalogDocumentSha256(JSON.parse(onServedFramework(JSON.stringify(sentrySource)))),
      ],
    ]),
    hostedClients: new Set<string>(),
    metadata: new Map([
      [
        review[0]!.methods.oauth!.kind === "automatic" ? review[0]!.methods.oauth!.metadata : "",
        { sha256: catalogDocumentSha256(metadata), document: metadata },
      ],
    ]),
  };
  assert.deepEqual(
    oauthFitness(withOAuthDeferrals(withSentryConnections(official), review), review, evidence),
    [],
  );
  assert.ok(
    oauthFitness(official, review, { ...evidence, sources: new Map() }).some((problem) =>
      problem.includes("source changed"),
    ),
  );
  assert.throws(
    () =>
      withSentryConnections({
        ...official,
        apps: [{ ...official.apps[0]!, package: "unexpected" }],
      }),
    /package changed/,
  );
});
