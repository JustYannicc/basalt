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
  let calls = 0;
  const check = () =>
    runCatalogSources({
      root,
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
