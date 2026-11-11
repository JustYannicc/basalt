import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSourceArtifacts,
  parseCatalogSourceManifest,
  runCatalogSources,
  updateSourceProvenance,
} from "./catalog-sources.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "catalog-source-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = parseCatalogSourceManifest({
    schema: 1,
    apps: ["aws", "atlassian", "zendesk"].map((name) => ({
      package: name,
      repository: `JustYannicc/signalbox-app-${name}`,
      commit: "a".repeat(40),
      files: ["package.json", "index.ts"],
    })),
  });
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/catalog-sources.json"), JSON.stringify(manifest));
  for (const app of manifest.apps) {
    const directory = join(root, "src/catalog", app.package);
    await mkdir(directory, { recursive: true });
    const artifacts = createSourceArtifacts(app.package, [
      { path: "index.ts", content: "export const original = true;\n" },
      { path: "package.json", content: JSON.stringify({ name: app.package }) },
    ]);
    await writeFile(join(directory, "source.json"), artifacts.snapshot);
    await writeFile(
      join(directory, "provenance.json"),
      updateSourceProvenance({ sourceSha256: "", catalogFileSha256: {} }, app, artifacts),
    );
  }
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["add", "scripts/catalog-sources.json", "src/catalog"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Catalog fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "Verified source fixture",
    ],
    { cwd: root },
  );
  let calls = 0;
  const check = () =>
    runCatalogSources({
      root,
      baseRef: "HEAD",
      github: {
        async get() {
          calls++;
          throw new Error("GitHub API unavailable");
        },
      },
    });
  return {
    root,
    manifest,
    check,
    calls: () => calls,
    source: join(root, "src/catalog/aws/source.json"),
    provenance: join(root, "src/catalog/aws/provenance.json"),
  };
}

test("checks unchanged committed pins without any GitHub requests", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("offline checks must not fetch"));
  const f = await fixture(t);
  await f.check();
  assert.equal(f.calls(), 0);
});

test("fails on changed source bytes instead of accepting or refreshing their hashes", async (t) => {
  const f = await fixture(t);
  const snapshot = JSON.parse(await readFile(f.source, "utf8"));
  snapshot.files[0].content = "export const tampered = true;\n";
  await writeFile(f.source, `${JSON.stringify(snapshot, null, 2)}\n`);
  await assert.rejects(f.check(), /Catalog source drift for aws: snapshot or file SHA-256/);
  assert.equal(f.calls(), 0);
});

for (const change of [
  "commit",
  "repository",
  "allowlist",
  "snapshotHash",
  "fileHash",
  "legacyHash",
  "missingProvenance",
  "duplicateFile",
  "extraFile",
] as const) {
  test(`fails offline when ${change} differs from the committed source`, async (t) => {
    const f = await fixture(t);
    const provenance = JSON.parse(await readFile(f.provenance, "utf8"));
    const snapshot = JSON.parse(await readFile(f.source, "utf8"));
    if (change === "commit") f.manifest.apps[0]!.commit = "b".repeat(40);
    if (change === "repository")
      provenance.catalogSource.repository = "https://github.com/other/repository";
    if (change === "allowlist") f.manifest.apps[0]!.files.push("new.ts");
    if (change === "snapshotHash") provenance.catalogSource.snapshotSha256 = "0".repeat(64);
    if (change === "fileHash") provenance.catalogSource.fileSha256["index.ts"] = "0".repeat(64);
    if (change === "legacyHash") provenance.sourceSha256 = "0".repeat(64);
    if (change === "missingProvenance") delete provenance.catalogSource;
    if (change === "duplicateFile") snapshot.files.push(snapshot.files[0]);
    if (change === "extraFile") snapshot.files.push({ path: "extra.ts", content: "export {};" });
    await writeFile(join(f.root, "scripts/catalog-sources.json"), JSON.stringify(f.manifest));
    await writeFile(f.source, `${JSON.stringify(snapshot, null, 2)}\n`);
    await writeFile(f.provenance, `${JSON.stringify(provenance, null, 2)}\n`);
    await assert.rejects(f.check(), /Catalog source drift for aws:/);
    assert.equal(f.calls(), 0);
  });
}

test("a failed explicit refresh leaves every committed source and hash unchanged", async (t) => {
  const f = await fixture(t);
  const before = await Promise.all([readFile(f.source), readFile(f.provenance)]);
  await assert.rejects(
    runCatalogSources({
      root: f.root,
      write: true,
      github: {
        async get() {
          throw new Error("GitHub API unavailable: HTTP 503");
        },
      },
    }),
    /GitHub API unavailable/,
  );
  assert.deepEqual(await Promise.all([readFile(f.source), readFile(f.provenance)]), before);
});

function repositoryReader(
  manifest: ReturnType<typeof parseCatalogSourceManifest>,
  calls: string[],
  changedContent?: string,
) {
  return {
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      const app = manifest.apps.find((app) => path.startsWith(`repos/${app.repository}/`))!;
      const treeSha = "d".repeat(40);
      const files = [
        { path: "index.ts", content: changedContent ?? "export const original = true;\n" },
        { path: "package.json", content: JSON.stringify({ name: app.package }) },
      ];
      const blobs = files.map((file) => {
        const bytes = Buffer.from(file.content);
        const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        return { ...file, bytes, sha };
      });
      if (path.endsWith(`/commits/${app.commit}`))
        return { sha: app.commit, commit: { tree: { sha: treeSha } } } as T;
      if (path.endsWith(`/git/trees/${treeSha}?recursive=1`))
        return {
          sha: treeSha,
          truncated: false,
          tree: blobs.map(({ path, sha }) => ({ path, sha, mode: "100644", type: "blob" })),
        } as T;
      const blob = blobs.find((blob) => path.endsWith(`/git/blobs/${blob.sha}`));
      assert.ok(blob, `unexpected GitHub fixture path ${path}`);
      return {
        sha: blob.sha,
        size: blob.bytes.length,
        encoding: "base64",
        content: blob.bytes.toString("base64"),
      } as T;
    },
  };
}

async function repin(f: Awaited<ReturnType<typeof fixture>>) {
  f.manifest.apps[0]!.commit = "b".repeat(40);
  const provenance = JSON.parse(await readFile(f.provenance, "utf8"));
  provenance.catalogSource.commit = "b".repeat(40);
  await writeFile(join(f.root, "scripts/catalog-sources.json"), JSON.stringify(f.manifest));
  await writeFile(f.provenance, `${JSON.stringify(provenance, null, 2)}\n`);
}

test("changing both commit fields cannot attest an unverified pin", async (t) => {
  const f = await fixture(t);
  await repin(f);
  await assert.rejects(f.check(), /GitHub API unavailable/);
  assert.ok(f.calls() > 0);
});

test("a changed pin fetches only that repository and a real remote hash mismatch fails", async (t) => {
  const f = await fixture(t);
  await repin(f);
  const before = await readFile(f.source);
  const calls: string[] = [];
  await assert.rejects(
    runCatalogSources({
      root: f.root,
      baseRef: "HEAD",
      github: repositoryReader(f.manifest, calls, "export const remote = true;\n"),
    }),
    /Catalog source drift for aws:.*index\.ts:/,
  );
  assert.ok(calls.length > 0);
  assert.ok(calls.every((path) => path.startsWith("repos/JustYannicc/signalbox-app-aws/")));
  assert.deepEqual(await readFile(f.source), before);
});

test("accepts a changed pin only after its fetched contents match", async (t) => {
  const f = await fixture(t);
  await repin(f);
  const calls: string[] = [];
  await runCatalogSources({
    root: f.root,
    baseRef: "HEAD",
    github: repositoryReader(f.manifest, calls),
  });
  assert.ok(calls.some((path) => path.endsWith(`/commits/${"b".repeat(40)}`)));
});

test("candidate source and hash edits cannot replace the trusted base hashes", async (t) => {
  const f = await fixture(t);
  const snapshot = JSON.parse(await readFile(f.source, "utf8"));
  snapshot.files[0].content = "export const invented = true;\n";
  const artifacts = createSourceArtifacts("aws", snapshot.files);
  const provenance = JSON.parse(await readFile(f.provenance, "utf8"));
  await writeFile(f.source, artifacts.snapshot);
  await writeFile(f.provenance, updateSourceProvenance(provenance, f.manifest.apps[0]!, artifacts));
  const calls: string[] = [];
  await assert.rejects(
    runCatalogSources({
      root: f.root,
      baseRef: "HEAD",
      github: repositoryReader(f.manifest, calls),
    }),
    /Catalog source drift for aws:.*index\.ts:/,
  );
  assert.ok(calls.length > 0);
});

test("missing trusted base evidence requires remote verification of every app", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  await runCatalogSources({
    root: f.root,
    baseRef: "missing-base-ref",
    github: repositoryReader(f.manifest, calls),
  });
  for (const app of f.manifest.apps)
    assert.ok(calls.some((path) => path.startsWith(`repos/${app.repository}/commits/`)));
});

test("allowlist refusal names every blocked package and path", async (t) => {
  const f = await fixture(t);
  f.manifest.apps[0]!.files.push("new-aws.ts");
  f.manifest.apps[1]!.files.push("new-atlassian.ts");
  await writeFile(join(f.root, "scripts/catalog-sources.json"), JSON.stringify(f.manifest));
  await assert.rejects(f.check(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Catalog source drift for aws:.*new-aws\.ts/);
    assert.match(error.message, /Catalog source drift for atlassian:.*new-atlassian\.ts/);
    assert.match(error.message, / -> /);
    return true;
  });
});
