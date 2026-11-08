import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compatibilityPoolManifest,
  poolCompatibilityCommit,
  poolReleaseAssets,
  preparePoolCompatibilityContext,
} from "./ci/pool-release-assets.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const command = 'RUN python3 fetch_releases.py --arch "$TARGETARCH" --destination /out';
const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "basalt-pool-cache-"));
  const context = join(temporary, "context");
  const cache = join(temporary, "cache");
  mkdirSync(context);
  mkdirSync(cache);
  const asset = (role: string) => {
    const bytes = Buffer.from(`archive bytes for ${role}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(cache, sha256 + ".tar.gz"), bytes);
    return {
      repository: `fixture/${role}`,
      tag: "v1.fixture",
      assets: {
        amd64: { name: `${role}.tar.gz`, sha256 },
        arm64: { name: `${role}-arm64.tar.gz`, sha256 },
      },
    };
  };
  const manifest = { format_version: 1, artifacts: { home: asset("home"), node: asset("node") } };
  writeFileSync(join(context, "releases.json"), JSON.stringify(manifest));
  writeFileSync(join(context, "Dockerfile"), command + "\n");
  return { temporary, context, cache, manifest };
}

test("compatibility cache identity follows its frozen release pins and architecture", () => {
  const manifest = compatibilityPoolManifest(root);
  const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  const steps = workflow.jobs["pool-runtime"].steps;
  const warm = steps.findIndex(
    (step: { uses?: string }) => step.uses === "./.github/actions/pool-release-assets",
  );
  const build = steps.findIndex(
    (step: { name?: string }) => step.name === "Build the pinned pool image",
  );
  assert.ok(warm >= 0 && warm < build);
  assert.ok(steps[build].run.includes(`git archive ${poolCompatibilityCommit} containers/pool`));
  assert.ok(steps[build].run.includes("pool-release-assets.ts context"));
  assert.notEqual(poolReleaseAssets(manifest).key, poolReleaseAssets(manifest, "arm64").key);
  const changed = structuredClone(manifest);
  changed.artifacts.node.tag = "v.changed";
  assert.notEqual(poolReleaseAssets(manifest).key, poolReleaseAssets(changed).key);
  for (const asset of poolReleaseAssets(manifest).assets)
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    readFileSync(join(root, "containers/pool/Dockerfile"), "utf8"),
    /fetch_releases\.py/,
  );
});

test("the historical Docker context embeds only verified archives and forces offline consumption", () => {
  const data = fixture();
  try {
    preparePoolCompatibilityContext(root, data.context, data.cache, data.manifest);
    const dockerfile = readFileSync(join(data.context, "Dockerfile"), "utf8");
    assert.match(dockerfile, /COPY \.release-archives \/release-archives/);
    assert.match(
      dockerfile,
      /RUN BASALT_POOL_RELEASE_ARCHIVE_DIR=\/release-archives python3 fetch_releases\.py/,
    );
    assert.equal(
      readFileSync(join(data.context, "fetch_releases.py"), "utf8"),
      readFileSync(join(root, "containers/pool/fetch_releases.py"), "utf8"),
    );
    for (const asset of poolReleaseAssets(data.manifest).assets)
      assert.deepEqual(
        readFileSync(join(data.context, ".release-archives", asset.sha256 + ".tar.gz")),
        readFileSync(join(data.cache, asset.sha256 + ".tar.gz")),
      );
  } finally {
    rmSync(data.temporary, { recursive: true, force: true });
  }
});

test("corrupt archives and changed historical pins refuse before rewriting the Dockerfile", () => {
  const data = fixture();
  try {
    const asset = poolReleaseAssets(data.manifest).assets[0]!;
    writeFileSync(join(data.cache, asset.sha256 + ".tar.gz"), "bad");
    assert.throws(
      () => preparePoolCompatibilityContext(root, data.context, data.cache, data.manifest),
      /checksum mismatch/,
    );
    assert.equal(readFileSync(join(data.context, "Dockerfile"), "utf8"), command + "\n");
    writeFileSync(join(data.context, "releases.json"), "{}");
    assert.throws(
      () => preparePoolCompatibilityContext(root, data.context, data.cache, data.manifest),
      /frozen release pins/,
    );
  } finally {
    rmSync(data.temporary, { recursive: true, force: true });
  }
});
