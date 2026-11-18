import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compatibilityImageRecipe,
  compatibilityImagesKey,
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
  const action = parse(
    readFileSync(join(root, ".github/actions/pool-compatibility-images/action.yml"), "utf8"),
  );
  const steps = action.runs.steps;
  const warm = steps.findIndex(
    (step: { uses?: string }) => step.uses === "./.github/actions/pool-release-assets",
  );
  const named = (name: string) => steps.findIndex((step: { name?: string }) => step.name === name);
  const context = named("Prepare the pinned compatibility image context");
  const restore = named("Restore the built compatibility images");
  const build = named("Load or build the compatibility images");
  const save = named("Keep the built compatibility images for later runs");
  assert.ok(warm === 0 && warm < context && context < restore && restore < build && build < save);
  assert.ok(steps[context].run.includes(`git archive ${poolCompatibilityCommit} containers/pool`));
  assert.ok(steps[context].run.includes("pool-release-assets.ts context"));
  assert.equal(steps[restore].with.key, "${{ steps.context.outputs.key }}");
  assert.equal(steps[save].with.key, "${{ steps.context.outputs.key }}");
  assert.equal(steps[save].if, "steps.cache.outputs.cache-hit != 'true'");
  // Only the shard whose tests read them loads the compatibility images, before its contracts run.
  const runtime = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).jobs[
    "pool-runtime"
  ].steps;
  const load = runtime.findIndex(
    (step: { uses?: string }) => step.uses === "./.github/actions/pool-compatibility-images",
  );
  const contracts = runtime.findIndex(
    (step: { name?: string }) => step.name === "Check the pool runtime and database contracts",
  );
  assert.ok(load >= 0 && load < contracts);
  assert.equal(runtime[load].if, "matrix.shard == 'compatibility'");
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

test("built compatibility images are reused only for a byte-identical context", () => {
  const data = fixture();
  try {
    preparePoolCompatibilityContext(root, data.context, data.cache, data.manifest);
    const key = compatibilityImagesKey(data.context, "amd64", root);
    assert.match(key, /^pool-compatibility-images-v1-amd64-[a-f0-9]{64}$/);
    assert.notEqual(compatibilityImagesKey(data.context, "arm64", root), key);
    assert.equal(compatibilityImagesKey(data.context, "amd64", root), key);
    const archive = join(
      data.context,
      ".release-archives",
      poolReleaseAssets(data.manifest).assets[0]!.sha256 + ".tar.gz",
    );
    const bytes = readFileSync(archive);
    writeFileSync(archive, Buffer.concat([bytes, Buffer.from("x")]));
    assert.notEqual(compatibilityImagesKey(data.context, "amd64", root), key);
    writeFileSync(archive, bytes);
    assert.equal(compatibilityImagesKey(data.context, "amd64", root), key);
    const script = join(data.context, "fetch_releases.py");
    const mode = statSync(script).mode & 0o777;
    chmodSync(script, mode ^ 0o100);
    assert.notEqual(compatibilityImagesKey(data.context, "amd64", root), key);
    chmodSync(script, mode);
    writeFileSync(join(data.context, "extra.txt"), "");
    assert.notEqual(compatibilityImagesKey(data.context, "amd64", root), key);
    // The recipe that maps targets to tags is part of what the cached images are.
    const recipe = mkdtempSync(join(data.temporary, "recipe-"));
    for (const file of compatibilityImageRecipe) {
      mkdirSync(join(recipe, file, ".."), { recursive: true });
      writeFileSync(join(recipe, file), readFileSync(join(root, file)));
    }
    rmSync(join(data.context, "extra.txt"));
    assert.equal(compatibilityImagesKey(data.context, "amd64", recipe), key);
    const action = join(recipe, compatibilityImageRecipe[0]!);
    writeFileSync(action, readFileSync(action, "utf8").replace("legacy-runtime", "runtime"));
    assert.notEqual(compatibilityImagesKey(data.context, "amd64", recipe), key);
  } finally {
    rmSync(data.temporary, { recursive: true, force: true });
  }
});
