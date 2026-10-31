import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atlassianAddition } from "./atlassian/index.ts";
import { handleCatalog } from "./worker.ts";
import type { Feed } from "./feed.ts";

const official: Feed = { version: 1, apps: [] };

test("the feed offers the personal Atlassian app with its one-sentence description", async () => {
  const response = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/index.json"),
    async () => Response.json(official),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Feed;
  const entry = body.apps.find((app) => app.id === "atlassian")!;
  assert.equal(entry.package, "atlassian");
  assert.equal(entry.source, "apps/atlassian.json");
  assert.deepEqual(entry.auth, [{ method: "oauth", kind: "oauth2" }]);
  assert.equal(entry.connectionNotices, undefined);
  assert.doesNotMatch(entry.description, /executor/i);
});

test("the app source is served locally without contacting the official publisher", async () => {
  const noFetch: typeof fetch = async () => {
    throw new Error("Unexpected publisher call");
  };
  const url = "https://app.signalbox.run/catalog/apps/atlassian.json";
  const response = await handleCatalog(
    new Request(url, {
      headers: { Authorization: "Bearer fixture", Cookie: "session=fixture" },
    }),
    noFetch,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), atlassianAddition().source);
  const head = await handleCatalog(new Request(url, { method: "HEAD" }), noFetch);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await handleCatalog(new Request(url, { method: "POST" }), noFetch)).status, 405);
});

test("the Atlassian carry preserves its captured baseline and adds the full 3LO package", () => {
  const capture = (name: string) => readFileSync(new URL(`./atlassian/${name}`, import.meta.url));
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const publicBytes = capture("source.published.json");
  const servedBytes = capture("source.json");
  const publicSource = JSON.parse(publicBytes.toString());
  const served = JSON.parse(servedBytes.toString());
  const provenance = JSON.parse(capture("provenance.json").toString());
  const patch = capture("source.patch");
  assert.equal(provenance.revision, "3f97ddff8ce4eb358ca942b93f34c90ccc7c948c");
  assert.equal(digest(publicBytes), provenance.publicSource.snapshotSha256);
  assert.equal(digest(servedBytes), provenance.snapshotSha256);
  assert.equal(digest(patch), provenance.localPatch.sha256);
  assert.equal(provenance.localPatch.path, "source.patch");
  assert.equal(publicSource.package, "atlassian");
  assert.equal(served.package, publicSource.package);
  assert.deepEqual(
    served.files.map((file: { path: string }) => file.path),
    [
      "index.ts",
      "package.json",
      "provider.ts",
      "queries.ts",
      "configuration.ts",
      "openapi.ts",
      "transport.ts",
      "api-coverage.json",
      "README.md",
    ],
  );
  const directory = mkdtempSync(join(tmpdir(), "basalt-atlassian-carry-"));
  try {
    for (const file of publicSource.files) {
      assert.ok(["index.ts", "package.json"].includes(file.path));
      assert.equal(digest(file.content), provenance.publicSource.files[file.path]);
      writeFileSync(join(directory, file.path), file.content);
    }
    execFileSync("git", ["apply", new URL("./atlassian/source.patch", import.meta.url).pathname], {
      cwd: directory,
    });
    for (const file of served.files) {
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content);
      assert.equal(digest(file.content), provenance.files[file.path]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const manifest = (source: typeof served) =>
    JSON.parse(source.files.find((file: { path: string }) => file.path === "package.json").content);
  const originalManifest = manifest(publicSource);
  const servedManifest = manifest(served);
  assert.equal(originalManifest.dependencies.apps, "0.0.1-beta.103");
  assert.equal(servedManifest.dependencies.apps, "0.0.1-beta.104-basalt.1");
  assert.equal(servedManifest.name, "atlassian");
  assert.equal(servedManifest.private, true);
  assert.equal(servedManifest.type, "module");
  assert.deepEqual(servedManifest, {
    ...originalManifest,
    dependencies: { ...originalManifest.dependencies, apps: "0.0.1-beta.104-basalt.1" },
  });
  const sourceFile = (path: string) =>
    served.files.find((file: { path: string }) => file.path === path).content;
  const coverage: Record<string, { retainedOperations: number }> = JSON.parse(
    sourceFile("api-coverage.json"),
  );
  assert.deepEqual(Object.keys(coverage), [
    "jira",
    "serviceManagement",
    "confluence",
    "confluenceV2",
  ]);
  assert.equal(
    Object.values(coverage).reduce((sum, api) => sum + api.retainedOperations, 0),
    1038,
  );
  assert.equal(provenance.capabilities.requestedScopes.length, 73);
  assert.ok(provenance.capabilities.requestedScopes.includes("read:me"));
  assert.ok(provenance.capabilities.requestedScopes.includes("write:jira-work"));
  assert.ok(provenance.capabilities.requestedScopes.includes("write:page:confluence"));
  assert.ok(provenance.capabilities.requestedScopes.includes("write:confluence-content"));
  assert.ok(!provenance.capabilities.requestedScopes.includes("read:app-data:confluence"));
  assert.equal(provenance.capabilities.hostedGranularRegistrationVerified, false);
  assert.match(sourceFile("index.ts"), /tool\.kind === "mutation" \? always\(\) : undefined/);
  assert.match(sourceFile("transport.ts"), /url\.origin === apiOrigin/);
});
