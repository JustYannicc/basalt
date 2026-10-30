import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import source from "./gitlab.json" with { type: "json" };
import { gitlabSource } from "./gitlab.ts";

test("GitLab serves the carried source without contacting the publisher", async () => {
  const noFetch: typeof fetch = async () => { throw new Error("Unexpected publisher call"); };
  const response = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/apps/gitlab.json"),
    noFetch,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), gitlabSource);
  const head = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/apps/gitlab.json", { method: "HEAD" }),
    noFetch,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("GitLab provenance binds the published package, account-site patch and host framework", () => {
  const capture = (name: string) => readFileSync(new URL(name, import.meta.url));
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const publishedBytes = capture("./gitlab.published.json");
  const carriedBytes = capture("./gitlab.json");
  const patchBytes = capture("./gitlab.patch");
  const published = JSON.parse(publishedBytes.toString());
  const carried = JSON.parse(carriedBytes.toString());
  const provenance = JSON.parse(capture("./gitlab.provenance.json").toString());

  assert.equal(digest(publishedBytes), provenance.publishedSha256);
  assert.equal(digest(carriedBytes), provenance.carriedSha256);
  assert.equal(digest(patchBytes), provenance.patchSha256);
  assert.equal(published.package, "@executor.sh/gitlab");
  assert.equal(carried.package, published.package);
  assert.deepEqual(carried.files.map((file: { path: string }) => file.path),
    published.files.map((file: { path: string }) => file.path));
  for (const file of published.files as { path: string; content: string }[])
    assert.equal(digest(file.content), provenance.publishedFileSha256[file.path]);
  for (const file of carried.files as { path: string; content: string }[])
    assert.equal(digest(file.content), provenance.carriedFileSha256[file.path]);

  const temporary = mkdtempSync(join(tmpdir(), "basalt-gitlab-carry-"));
  try {
    for (const file of published.files as { path: string; content: string }[])
      writeFileSync(join(temporary, file.path), file.content);
    execFileSync("git", ["apply", new URL("./gitlab.patch", import.meta.url).pathname], {
      cwd: temporary,
    });
    for (const file of carried.files as { path: string; content: string }[])
      assert.equal(readFileSync(join(temporary, file.path), "utf8"), file.content);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const manifest = JSON.parse(source.files.find(file => file.path === "package.json")!.content);
  assert.equal(manifest.dependencies.apps, provenance.appsVersion);
  assert.equal(provenance.license, "Not declared in the published package");
  assert.match(source.files.find(file => file.path === "index.ts")!.content, /defaultOrigin: true/);
});
