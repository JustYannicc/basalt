import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Runs in Check's client-desktop job, after clients/desktop's dependencies are installed, against
// the real locked Electron. The fixture test in scripts/ci-release-assets.test.ts covers the config
// shape without them.
const desktopManifest = new URL("../../clients/desktop/package.json", import.meta.url);
const installedElectron = new URL(
  "../../clients/desktop/node_modules/electron/checksums.json",
  import.meta.url,
);

test("the generated electron-builder config carries the locked electron's checksums", () => {
  assert.ok(
    existsSync(installedElectron),
    "clients/desktop dependencies are not installed: run bun install --cwd clients/desktop first",
  );
  const fixture = mkdtempSync(join(tmpdir(), "basalt-builder-config-"));
  try {
    const output = join(fixture, "electron-builder.json");
    const script = new URL("./desktop-release-assets.ts", import.meta.url).pathname;
    execFileSync(process.execPath, [script, "builder-config", output], { stdio: "pipe" });
    const config = JSON.parse(readFileSync(output, "utf8"));
    const checksums = JSON.parse(readFileSync(installedElectron, "utf8"));
    assert.deepEqual(config, {
      ...JSON.parse(readFileSync(desktopManifest, "utf8")).build,
      electronDownload: { unsafelyDisableChecksums: false, checksums },
    });
    const lock = readFileSync(new URL("../../clients/desktop/bun.lock", import.meta.url), "utf8");
    const version = /^    "electron": \["electron@([^"\s]+)"/m.exec(lock)![1];
    for (const platform of ["linux-x64", "win32-x64"])
      assert.match(checksums[`electron-v${version}-${platform}.zip`], /^[0-9a-f]{64}$/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
