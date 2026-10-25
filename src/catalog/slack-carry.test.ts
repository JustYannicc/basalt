import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("the Slack carry is its frozen source, public contribution and Basalt framework pin", () => {
  const originalBytes = readFileSync(new URL("./slack.published.json", import.meta.url));
  const original = JSON.parse(originalBytes.toString());
  const carried = JSON.parse(readFileSync(new URL("./slack.json", import.meta.url), "utf8"));
  const provenance = JSON.parse(readFileSync(new URL("./slack.provenance.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(originalBytes).digest("hex"), provenance.publishedSha256);
  assert.equal(createHash("sha256").update(readFileSync(new URL("./slack.json", import.meta.url))).digest("hex"), provenance.carriedSha256);
  assert.equal(createHash("sha256").update(readFileSync(new URL("./slack.patch", import.meta.url))).digest("hex"), provenance.patchSha256);
  assert.equal(createHash("sha256").update(readFileSync(new URL("./slack.basalt.patch", import.meta.url))).digest("hex"), provenance.basaltOverlay.sha256);
  assert.equal(original.package, "@executor.sh/slack");
  assert.equal(carried.package, original.package);
  const directory = mkdtempSync(join(tmpdir(), "basalt-slack-carry-"));
  try {
    for (const file of original.files) {
      assert.match(file.path, /^[a-zA-Z0-9._/-]+$/);
      assert.ok(!file.path.startsWith("/") && !file.path.split("/").includes(".."));
      const target = join(directory, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    execFileSync("git", ["apply", new URL("./slack.patch", import.meta.url).pathname], { cwd: directory });
    const publicManifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const publishedManifest = JSON.parse(original.files.find((file: { path: string }) => file.path === "package.json").content);
    assert.equal(publicManifest.dependencies.apps, publishedManifest.dependencies.apps,
      "The public contribution must retain its published framework release");
    execFileSync("git", ["apply", new URL("./slack.basalt.patch", import.meta.url).pathname], { cwd: directory });
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const host = JSON.parse(readFileSync(new URL("../../.upstream/packages/apps/package.json", import.meta.url), "utf8"));
    assert.equal(manifest.dependencies.apps, host.version);
    assert.equal(manifest.dependencies.apps, provenance.basaltOverlay.appsVersion);
    const files = readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(file => file.isFile()).map(file => join(file.parentPath, file.name).slice(directory.length + 1)).sort();
    assert.deepEqual(files, carried.files.map((file: { path: string }) => file.path).sort());
    for (const file of carried.files) assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content, file.path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Slack registration manifest requests exactly the carried app's user scopes", () => {
  const carried = JSON.parse(readFileSync(new URL("./slack.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("./slack.manifest.json", import.meta.url), "utf8"));
  const source = carried.files.find((file: { path: string }) => file.path === "index.ts").content as string;
  const declared = source.match(/const userScopes = (\[[\s\S]*?\]) as const;/);
  assert.ok(declared, "The carried scope list must stay statically inspectable");
  const scopes = [...declared[1]!.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(manifest.oauth_config.scopes, { user: scopes });
  assert.deepEqual(manifest.oauth_config.redirect_urls, ["https://app.signalbox.run/api/oauth/callback"]);
  assert.equal(manifest.features?.bot_user, undefined);
});
