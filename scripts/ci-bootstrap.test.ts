import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import { actionlintSource } from "./ci/actionlint.ts";
import { downloadVerified } from "./ci/verified-download.mjs";

test("verified cache hits make no request, and corrupt archives fail before use", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-archive-cache-"));
  try {
    const archive = join(root, "archive");
    writeFileSync(archive, "fixture bytes");
    const integrity = "sha256-" + createHash("sha256").update("fixture bytes").digest("base64");
    downloadVerified("https://release-assets-blocked.invalid/archive", integrity, archive);
    writeFileSync(archive, "corrupted");
    assert.throws(
      () => downloadVerified("https://release-assets-blocked.invalid/archive", integrity, archive),
      /checksum mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actionlint cold population uses pinned Go source and fast requires the warmed cache", () => {
  assert.equal(new URL(actionlintSource.url).host, "proxy.golang.org");
  assert.match(actionlintSource.sha256, /^[a-f0-9]{64}$/);
  const launcher = readFileSync(new URL("./ci/check-workflows.ts", import.meta.url), "utf8");
  assert.doesNotMatch(launcher, /github\.com.*releases\/download/);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const action = "./.github/actions/setup-actionlint";
  assert.ok(workflow.jobs.select.steps.some((step: { uses?: string }) => step.uses === action));
  assert.equal(
    workflow.jobs.fast.steps.find((step: { uses?: string }) => step.uses === action).with[
      "require-hit"
    ],
    "true",
  );
  assert.equal(workflow.jobs.fast.needs, "select");
});

test("Check toolchain bootstraps use official non-GitHub sources on every runner", async () => {
  const { bunAsset } = await import("./ci/setup-bun.ts");
  for (const version of ["1.4.2", "1.4.4"])
    for (const platform of [
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
    ]) {
      const asset = bunAsset(version, platform);
      assert.equal(new URL(asset.url).host, "registry.npmjs.org");
      assert.match(asset.integrity, /^sha512-/);
      assert.ok(asset.key.includes(version) && asset.key.includes(platform));
    }
  assert.throws(() => bunAsset("unlisted"), /No checksum-pinned Bun/);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  for (const id of Object.keys(workflow.jobs)) {
    for (const step of workflow.jobs[id].steps) {
      assert.ok(!step.uses?.startsWith("oven-sh/setup-bun@"), id);
      assert.ok(!step.uses?.startsWith("actions/setup-node@"), id);
    }
  }
});

test("Node bootstrap reads only pinned official archives and refuses unknown versions", async () => {
  const { nodeAsset } = await import("./ci/setup-node.mjs");
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
    const asset = nodeAsset("24.18.0", platform);
    assert.equal(asset.url, `https://nodejs.org/dist/v24.18.0/${asset.file}`);
    assert.match(asset.integrity, /^sha256-/);
    assert.match(asset.key, /node-dist-v1-24\.18\.0-.*[a-f0-9]{64}$/);
  }
  assert.throws(() => nodeAsset("unknown"), /No checksum-pinned Node/);
  assert.throws(() => nodeAsset("24.18.0", "unknown"), /No checksum-pinned Node/);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  for (const id of ["select", "fast", "workerd-assets", "check", "client-desktop"])
    assert.ok(
      workflow.jobs[id].steps.some(
        (step: { uses?: string }) => step.uses === "./.github/actions/setup-node",
      ),
      id,
    );
});

test("Windows toolchain archives bypass PATH tar for drive-letter paths", async () => {
  const { archiveTar } = await import("./ci/verified-download.mjs");
  const windows = archiveTar("win32");
  assert.equal(win32.isAbsolute(windows), true);
  assert.equal(
    windows,
    win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe"),
  );
  assert.notEqual(windows, "tar");
  for (const platform of ["linux", "darwin"]) assert.equal(archiveTar(platform), "tar");
});

test("Bun setup exposes both command entry points on Unix and Windows and can repeat", async () => {
  const { bunEntrypoints } = await import("./ci/setup-bun.ts");
  const platforms: NodeJS.Platform[] = ["linux", "win32"];
  for (const platform of platforms) {
    const root = mkdtempSync(join(tmpdir(), "basalt-bun-commands-"));
    try {
      const binary = join(root, platform === "win32" ? "bun.exe" : "bun");
      writeFileSync(binary, "installed Bun binary");
      const commands = bunEntrypoints(root, platform);
      for (const command of Object.values(commands)) {
        assert.equal(statSync(command).isFile(), true);
        assert.equal(readFileSync(command, "utf8"), "installed Bun binary");
      }
      assert.equal(statSync(commands.bun).ino, statSync(commands.bunx).ino);
      writeFileSync(binary, "updated Bun binary");
      assert.deepEqual(bunEntrypoints(root, platform), commands);
      assert.equal(readFileSync(commands.bunx, "utf8"), "updated Bun binary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
