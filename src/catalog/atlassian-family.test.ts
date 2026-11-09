import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { atlassianConsumers } from "./atlassian-consumers.ts";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import type { Feed } from "./feed.ts";

const official: Feed = {
  version: 1,
  apps: ["gmail", "jira", "confluence", "trello"].map((id) => ({
    id,
    package: `@executor.sh/${id}`,
    name: id,
    description: `${id} tools`,
    auth: [{ method: id === "jira" || id === "confluence" ? "OAuth2" : "oauth", kind: "oauth2" }],
    icons: [],
    source: `apps/${id}.json`,
  })),
};

test("families keep their consuming apps without an umbrella app or catalog-service alias", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json(official),
  );
  assert.equal(response.status, 200);
  const feed = (await response.json()) as Feed;
  for (const id of ["google", "atlassian"])
    assert.equal(
      feed.apps.some((entry) => entry.id === id),
      false,
    );
  for (const id of ["gmail", "jira", "confluence", "trello"]) {
    const entries = feed.apps.filter((entry) => entry.id === id);
    assert.equal(entries.length, 1, `${id} has one independent catalog entry`);
    assert.equal(entries[0]!.service?.id, `@executor.sh/${id}`);
    assert.deepEqual(entries[0]!.service?.packages, [`@executor.sh/${id}`]);
  }
});

test("retired umbrella source stays available for installed copies", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/atlassian.json"),
    async () => {
      throw new Error("A retained source must not contact its publisher");
    },
  );
  assert.equal(response.status, 200);
  const source = await response.json();
  assert.equal(source.package, "atlassian");
  assert.ok(source.files.some((file: { path: string }) => file.path === "provider.ts"));
});

for (const [name, source] of Object.entries(atlassianConsumers)) {
  test(`${name} retains the published tools with an explicit replayable patch`, () => {
    const read = (suffix: string) => readFileSync(new URL(`./${name}.${suffix}`, import.meta.url));
    const provenance = JSON.parse(read("provenance.json").toString());
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash(read("published.json")), provenance.publishedSha256);
    assert.equal(hash(read("json")), provenance.carriedSha256);
    assert.equal(hash(read("patch")), provenance.patchSha256);
    const scratch = mkdtempSync(join(tmpdir(), "atlassian-consumer-"));
    try {
      const original = JSON.parse(read("published.json").toString());
      for (const file of original.files) {
        const path = join(scratch, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      execFileSync("git", ["apply", "-"], { cwd: scratch, input: read("patch") });
      for (const file of source.files)
        assert.equal(readFileSync(join(scratch, file.path), "utf8"), file.content, file.path);
      assert.deepEqual(
        source.files.map((file) => file.path),
        original.files.map((file: { path: string }) => file.path),
      );
      if (name === "confluence") {
        const index = source.files.find((file) => file.path === "index.ts")!.content;
        assert.ok(!index.includes("read:app-data:confluence"));
        assert.ok(!index.includes("write:app-data:confluence"));
        assert.ok(index.includes("token:"), "the token method remains available");
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
