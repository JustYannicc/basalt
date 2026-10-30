import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Load the actual GitLab source from the catalog Worker and bind it to its reviewed files. */
export async function loadGitLabCatalogSource({ root, catalogOrigin }) {
  const response = await fetch(new URL("/catalog/apps/gitlab.json", catalogOrigin), {
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200, "Catalog Worker did not serve GitLab source over HTTP");
  const bytes = Buffer.from(await response.arrayBuffer());
  const source = JSON.parse(bytes.toString("utf8"));
  const [carriedBytes, patchBytes, publishedBytes, provenanceBytes] = await Promise.all([
    readFile(join(root, "src/catalog/gitlab.json")),
    readFile(join(root, "src/catalog/gitlab.patch")),
    readFile(join(root, "src/catalog/gitlab.published.json")),
    readFile(join(root, "src/catalog/gitlab.provenance.json")),
  ]);
  const expected = JSON.parse(carriedBytes.toString("utf8"));
  const published = JSON.parse(publishedBytes.toString("utf8"));
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));
  assert.equal(digest(carriedBytes), provenance.carriedSha256, "GitLab catalog source digest changed");
  assert.equal(digest(patchBytes), provenance.patchSha256, "GitLab source patch digest changed");
  assert.equal(digest(publishedBytes), provenance.publishedSha256, "GitLab published snapshot digest changed");
  assert.deepEqual(source, expected, "The catalog Worker changed the reviewed GitLab source");
  assert.equal(source.package, "@executor.sh/gitlab");
  assert.equal(published.package, source.package);
  assert.deepEqual(
    source.files.map(({ path }) => path).sort(),
    published.files.map(({ path }) => path).sort(),
    "The GitLab carry must keep every published source file",
  );
  for (const file of source.files)
    assert.equal(digest(file.content), provenance.carriedFileSha256[file.path], "GitLab carried file digest changed");
  return { source, provenance, published };
}
