import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostVersion } from "./host.mjs";

test("manifest preparation reads the pin's Git object and applies carries without a content API", () => {
  const root = mkdtempSync(join(tmpdir(), "app-lint-pin-"));
  const upstream = join(root, ".upstream");
  const scripts = join(root, "scripts/app-lint");
  const git = (...args) => execFileSync("git", args, { cwd: upstream, encoding: "utf8" }).trim();
  try {
    mkdirSync(join(upstream, "packages/apps"), { recursive: true });
    mkdirSync(scripts, { recursive: true });
    for (const file of ["prepare-host.mjs", "host.mjs", "source.mjs"])
      cpSync(new URL(file, import.meta.url), join(scripts, file));
    git("init", "--quiet");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    const manifest = join(upstream, "packages/apps/package.json");
    writeFileSync(manifest, '{"name":"apps","version":"0.0.1"}\n');
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "pinned manifest");
    const pin = git("rev-parse", "HEAD");
    writeFileSync(join(root, "upstream.json"), JSON.stringify({
      repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: pin,
    }));
    writeFileSync(manifest, '{"name":"apps","version":"0.0.2"}\n');
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "newer manifest");
    // Sparse source checkouts need no materialized manifest. HEAD also differs from the pin.
    rmSync(manifest);
    mkdirSync(join(root, "patches"));
    writeFileSync(join(root, "patches/0001-framework.patch"),
      'diff --git a/packages/apps/package.json b/packages/apps/package.json\n' +
      '--- a/packages/apps/package.json\n+++ b/packages/apps/package.json\n@@ -1 +1 @@\n' +
      '-{"name":"apps","version":"0.0.1"}\n+{"name":"apps","version":"0.0.1-basalt.1"}\n');
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "content API must not be called" >&2\nexit 99\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(scripts, "prepare-host.mjs")], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(readFileSync(join(root, ".ci-tools/app-lint-host.json"), "utf8"));
    assert.equal(saved.manifest.version, "0.0.1-basalt.1");
    assert.equal(hostVersion(root), "0.0.1-basalt.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
