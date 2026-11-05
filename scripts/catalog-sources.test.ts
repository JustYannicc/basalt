import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createSourceArtifacts,
  fetchPinnedSource,
  parseCatalogSourceManifest,
  updateSourceProvenance,
  type CatalogSourceApp,
  type GitHubSourceReader,
} from "./catalog-sources.ts";

const repositories = {
  aws: "JustYannicc/signalbox-app-aws",
  atlassian: "JustYannicc/signalbox-app-atlassian",
  zendesk: "JustYannicc/signalbox-app-zendesk",
} as const;

const commits = {
  aws: "a".repeat(40),
  atlassian: "b".repeat(40),
  zendesk: "c".repeat(40),
} as const;

function manifestValue() {
  return {
    schema: 1,
    apps: Object.keys(repositories).map((packageName) => ({
      package: packageName,
      repository: repositories[packageName as keyof typeof repositories],
      commit: commits[packageName as keyof typeof commits],
      files: ["package.json", "index.ts"],
    })),
  };
}

function appFor(packageName: keyof typeof repositories = "aws"): CatalogSourceApp {
  return parseCatalogSourceManifest(manifestValue()).apps.find(
    (app) => app.package === packageName,
  )!;
}

function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function readerFor(
  app: CatalogSourceApp,
  options: {
    contents?: Record<string, string>;
    treeEntries?: Array<{ path: string; mode: string; type: string; sha: string }>;
    truncated?: boolean;
    commitSha?: string;
    blobContents?: Record<string, string>;
  } = {},
): GitHubSourceReader {
  const treeSha = "d".repeat(40);
  const contents = options.contents ?? {
    "index.ts": `export const app = ${JSON.stringify(app.package)};\n`,
    "package.json": JSON.stringify({ name: app.package, private: true }),
  };
  const blobs = new Map<string, Buffer>();
  const entries =
    options.treeEntries ??
    Object.entries(contents).map(([path, content]) => {
      const bytes = Buffer.from(content, "utf8");
      const sha = gitBlobSha(bytes);
      blobs.set(sha, bytes);
      return { path, mode: "100644", type: "blob", sha };
    });
  if (options.treeEntries) {
    for (const content of Object.values(contents))
      blobs.set(gitBlobSha(Buffer.from(content)), Buffer.from(content));
  }

  return {
    async get<T>(path: string): Promise<T> {
      if (path === `repos/${app.repository}/commits/${app.commit}`)
        return { sha: options.commitSha ?? app.commit, commit: { tree: { sha: treeSha } } } as T;
      if (path === `repos/${app.repository}/git/trees/${treeSha}?recursive=1`)
        return { sha: treeSha, truncated: options.truncated ?? false, tree: entries } as T;
      const blobPrefix = `repos/${app.repository}/git/blobs/`;
      if (path.startsWith(blobPrefix)) {
        const sha = path.slice(blobPrefix.length);
        const bytes = blobs.get(sha);
        if (!bytes) throw new Error(`Unexpected blob ${sha}`);
        const override =
          options.blobContents &&
          Object.entries(options.blobContents).find(
            ([overridePath]) => entries.find((entry) => entry.path === overridePath)?.sha === sha,
          )?.[1];
        const content = Buffer.from(override ?? bytes.toString("utf8"), "utf8");
        return {
          sha,
          size: content.length,
          encoding: "base64",
          content: content.toString("base64"),
        } as T;
      }
      throw new Error(`Unexpected GitHub source request: ${path}`);
    },
  };
}

test("the manifest pins all three canonical public repositories and safe source paths", () => {
  const manifest = parseCatalogSourceManifest(manifestValue());
  assert.deepEqual(manifest.apps.map((app) => app.package).sort(), ["atlassian", "aws", "zendesk"]);
  assert.equal(manifest.apps.find((app) => app.package === "aws")?.repository, repositories.aws);

  const shortCommit = manifestValue();
  shortCommit.apps[0]!.commit = "abc123";
  assert.throws(
    () => parseCatalogSourceManifest(shortCommit),
    /full lowercase 40 character commit SHA/,
  );

  const wrongRepository = {
    ...manifestValue(),
    apps: manifestValue().apps.map((app) => ({ ...app, repository: "somebody/other-app" })),
  };
  assert.throws(() => parseCatalogSourceManifest(wrongRepository), /must use/);

  const unsafePath = manifestValue();
  unsafePath.apps[0]!.files = ["package.json", "src/../index.ts"];
  assert.throws(() => parseCatalogSourceManifest(unsafePath), /safe relative allowlist/);
  const nestedPath = manifestValue();
  nestedPath.apps[0]!.files = ["package.json", "src/index.ts"];
  assert.equal(parseCatalogSourceManifest(nestedPath).apps[0]!.files[1], "src/index.ts");
});

test("rejects a GitHub commit response that does not match the full pinned SHA", async () => {
  const app = appFor();
  await assert.rejects(
    fetchPinnedSource(app, readerFor(app, { commitSha: "e".repeat(40) })),
    /commit response did not match its pinned SHA/,
  );
});

test("rejects missing paths, symlinks, submodules, and truncated trees", async () => {
  const app = appFor();
  const contents = {
    "package.json": JSON.stringify({ name: app.package }),
    "index.ts": "export {};\n",
  };
  const ordinary = Object.entries(contents).map(([path, content]) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: gitBlobSha(Buffer.from(content)),
  }));

  await assert.rejects(
    fetchPinnedSource(
      app,
      readerFor(app, {
        contents,
        treeEntries: ordinary.filter((entry) => entry.path !== "index.ts"),
      }),
    ),
    /missing allowlisted file index\.ts/,
  );
  await assert.rejects(
    fetchPinnedSource(
      app,
      readerFor(app, {
        contents,
        treeEntries: ordinary.map((entry) =>
          entry.path === "index.ts" ? { ...entry, mode: "120000" } : entry,
        ),
      }),
    ),
    /not an ordinary Git blob/,
  );
  await assert.rejects(
    fetchPinnedSource(
      app,
      readerFor(app, {
        contents,
        treeEntries: ordinary.map((entry) =>
          entry.path === "index.ts" ? { ...entry, mode: "160000", type: "commit" } : entry,
        ),
      }),
    ),
    /not an ordinary Git blob/,
  );
  await assert.rejects(
    fetchPinnedSource(app, readerFor(app, { contents, truncated: true })),
    /truncated/,
  );
});

test("rejects a source package that changes the canonical package name", async () => {
  const app = appFor("atlassian");
  await assert.rejects(
    fetchPinnedSource(
      app,
      readerFor(app, {
        contents: {
          "package.json": JSON.stringify({ name: "renamed-atlassian" }),
          "index.ts": "export {};\n",
        },
      }),
    ),
    /must keep the package name atlassian/,
  );
});

test("rejects blob bytes that do not match the immutable Git tree blob SHA", async () => {
  const app = appFor("zendesk");
  await assert.rejects(
    fetchPinnedSource(
      app,
      readerFor(app, {
        contents: {
          "package.json": JSON.stringify({ name: app.package }),
          "index.ts": "export const original = true;\n",
        },
        blobContents: { "index.ts": "export const tampered = true;\n" },
      }),
    ),
    /blob integrity mismatch for index\.ts/,
  );
});

test("sorts snapshot files and hashes deterministically, preserving unrelated provenance", () => {
  const app = appFor();
  const files = [
    { path: "package.json", content: JSON.stringify({ name: app.package }) },
    { path: "index.ts", content: "export const stable = true;\n" },
  ];
  const first = createSourceArtifacts(app.package, files);
  const second = createSourceArtifacts(app.package, [...files].reverse());
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.deepEqual(first.fileSha256, second.fileSha256);
  assert.deepEqual(
    JSON.parse(first.snapshot.toString("utf8")).files.map((file: { path: string }) => file.path),
    ["index.ts", "package.json"],
  );

  const history = {
    repository: "legacy/upstream",
    revision: "old-revision",
    publicSource: { snapshotSha256: "historical", files: { "package.json": "historical" } },
    localPatch: { path: "source.patch", sha256: "historical" },
    originalFileSha256: { "package.json": "original" },
    baseline: { snapshotSha256: "baseline" },
    catalogFileSha256: { old: "old-digest" },
    snapshotSha256: "old-snapshot",
    sourceSha256: "old-source",
  };
  const written = updateSourceProvenance(history, app, first);
  const provenance = JSON.parse(written.toString("utf8"));
  assert.equal(provenance.repository, history.repository);
  assert.equal(provenance.revision, history.revision);
  assert.deepEqual(provenance.publicSource, history.publicSource);
  assert.deepEqual(provenance.localPatch, history.localPatch);
  assert.deepEqual(provenance.originalFileSha256, history.originalFileSha256);
  assert.deepEqual(provenance.baseline, history.baseline);
  assert.equal(provenance.snapshotSha256, first.snapshotSha256);
  assert.equal(provenance.sourceSha256, first.snapshotSha256);
  assert.deepEqual(provenance.catalogFileSha256, first.fileSha256);
  assert.deepEqual(provenance.catalogSource, {
    repository: `https://github.com/${app.repository}`,
    commit: app.commit,
    fileSha256: first.fileSha256,
    snapshotSha256: first.snapshotSha256,
  });
});
