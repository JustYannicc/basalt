import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { onServedFramework } from "./framework.ts";
import { handleCatalog } from "./worker.ts";
import { spotifySource } from "./spotify.ts";
import { catalog } from "./settings.ts";

const servedSource: typeof spotifySource = JSON.parse(
  onServedFramework(JSON.stringify(spotifySource)),
);

const published = () =>
  JSON.parse(
    readFileSync(new URL("./spotify.published.json", import.meta.url), "utf8"),
  ) as typeof spotifySource;

test("Spotify GET and HEAD serve the local override without its publisher", async () => {
  const responses = [];
  for (const method of ["GET", "HEAD"]) {
    const response = await handleCatalog(
      new Request("https://catalog.example.test/catalog/apps/spotify.json", { method }),
      async () => {
        throw new Error("Must serve locally");
      },
    );
    assert.equal(response.status, 200);
    responses.push(response);
  }
  assert.equal(onServedFramework(JSON.stringify(servedSource)), JSON.stringify(servedSource));
  assert.equal(await responses[0].text(), JSON.stringify(servedSource));
  assert.equal(await responses[1].text(), "");
  assert.deepEqual([...responses[0].headers], [...responses[1].headers]);
});

test("Spotify preserves the published package except its account check and host framework pin", () => {
  const bytes = (suffix: string) => readFileSync(new URL(`./spotify.${suffix}`, import.meta.url));
  const original = published();
  const provenance = JSON.parse(bytes("provenance.json").toString());
  for (const [suffix, key] of [
    ["published.json", "publishedSha256"],
    ["json", "carriedSha256"],
    ["patch", "patchSha256"],
  ])
    assert.equal(createHash("sha256").update(bytes(suffix)).digest("hex"), provenance[key]);
  assert.deepEqual({ ...spotifySource, files: [] }, { ...original, files: [] });
  assert.deepEqual(
    spotifySource.files.map((file) => file.path),
    original.files.map((file) => file.path),
  );
  for (const file of original.files) {
    const carried = spotifySource.files.find((candidate) => candidate.path === file.path)!;
    if (file.path === "package.json") {
      const publishedManifest = JSON.parse(file.content);
      const manifest = JSON.parse(carried.content);
      assert.equal(manifest.dependencies.apps, provenance.appsVersion);
      assert.equal(
        JSON.parse(servedSource.files.find((candidate) => candidate.path === file.path)!.content)
          .dependencies.apps,
        catalog.framework,
      );
      assert.deepEqual(
        {
          ...manifest,
          dependencies: { ...manifest.dependencies, apps: publishedManifest.dependencies.apps },
        },
        publishedManifest,
      );
    } else if (file.path !== "index.ts") assert.deepEqual(carried, file);
  }
});

test("Spotify patch reproduces every carried file", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-spotify-carry-"));
  try {
    for (const file of published().files) writeFileSync(join(directory, file.path), file.content);
    execFileSync("git", ["apply", fileURLToPath(new URL("./spotify.patch", import.meta.url))], {
      cwd: directory,
    });
    assert.deepEqual(
      readdirSync(directory).sort(),
      spotifySource.files.map((file) => file.path).sort(),
    );
    for (const file of spotifySource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content, file.path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Spotify account checks name the person, never the user id, against a synthetic peer", () => {
  assert.match(
    execFileSync("bun", ["scripts/connectors-tests/spotify-health.mjs"], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeout: 60_000,
    }),
    /health checks passed/,
  );
});
