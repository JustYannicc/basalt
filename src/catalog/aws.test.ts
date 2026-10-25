import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { aws } from "./aws/index.ts";
import { mergeFeed } from "./feed.ts";
import { handleCatalog } from "./worker.ts";

const sourceBytes = readFileSync(new URL("./aws/source.json", import.meta.url));
const source: { package: string; files: { path: string; content: string }[] } = JSON.parse(sourceBytes.toString("utf8"));
const provenance: { kind: string; upstreamIssue: string; sourceSha256: string; dependencies: Record<string, string> } = JSON.parse(
  readFileSync(new URL("./aws/provenance.json", import.meta.url), "utf8"),
);

test("AWS catalog provenance pins the self-contained published source and dependencies", () => {
  assert.equal(provenance.kind, "new-app-contribution");
  assert.match(provenance.upstreamIssue, /^https:\/\/github\.com\/UsefulSoftwareCo\/executor\/issues\/\d+$/);
  assert.equal(provenance.sourceSha256, createHash("sha256").update(sourceBytes).digest("hex"));
  assert.equal(source.package, "aws");
  assert.deepEqual(
    source.files.map((file) => file.path).sort(),
    [
      "README.md",
      "index.ts",
      "package.json",
      "src/aws.ts",
      "src/credentials.ts",
      "src/regions.ts",
      "src/xml.ts",
    ],
  );

  const manifestFile = source.files.find((file) => file.path === "package.json");
  assert.ok(manifestFile);
  const manifest = JSON.parse(manifestFile.content);
  assert.equal(manifest.name, "aws");
  assert.equal(source.package, "aws");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.dependencies, {
    apps: "0.0.1-beta.104-basalt.1",
    aws4fetch: "1.0.20",
    "fast-xml-parser": "5.11.1",
  });
  assert.deepEqual(provenance.dependencies, manifest.dependencies);
});

test("AWS appears in the public catalog with credential fields and bounded read scope", () => {
  const feed = mergeFeed({ version: 1, apps: [] }, [aws]);
  const entry = feed.apps.find((app) => app.id === "aws");

  assert.ok(entry);
  assert.equal(entry.package, "aws");
  assert.deepEqual(entry.auth, [{ method: "credentials", kind: "secrets", label: "AWS access keys" }]);
  const notice = entry.connectionNotices?.[0]?.message ?? "";
  assert.match(notice, /access key ID, secret access key, optional session token/);
  assert.match(notice, /One-click OAuth is unavailable/);
  assert.match(notice, /s3:ListAllMyBuckets/);
});

test("the AWS source route serves the pinned source and the index includes its catalog entry", async () => {
  let publisherCalls = 0;
  const noPublisher: typeof fetch = async () => {
    publisherCalls++;
    return Response.json({ version: 1, apps: [] });
  };

  const sourceResponse = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/apps/aws.json"),
    noPublisher,
  );
  assert.equal(sourceResponse.status, 200);
  assert.deepEqual(await sourceResponse.json(), source);
  assert.equal(publisherCalls, 0);

  const indexResponse = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/index.json"),
    noPublisher,
  );
  const feed: { apps: { id: string; source: string }[] } = await indexResponse.json();
  const entry = feed.apps.find((app) => app.id === "aws");
  assert.equal(indexResponse.status, 200);
  assert.ok(entry);
  assert.equal(entry.source, "apps/aws.json");
  assert.equal(publisherCalls, 1);
});
