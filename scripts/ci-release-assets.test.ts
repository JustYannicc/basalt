import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkRuntimeEnvironment,
  omitReleaseLifecycles,
  releaseOnlyDependencies,
} from "./ci/dependency-lifecycles.ts";
import { desktopAssetKey } from "./ci/desktop-release-assets.ts";

test("cold Check installs omit only unused release lifecycles with a frozen lockfile", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "basalt-release-lifecycles-"));
  try {
    const source = join(fixture, "source"),
      cold = join(fixture, "cold");
    mkdirSync(source);
    mkdirSync(cold);
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({
        name: "release-lifecycle-fixture",
        dependencies: { dugite: "3.2.3", electron: "44.4.2", esbuild: "0.28.2" },
        trustedDependencies: ["dugite", "electron", "esbuild"],
      }),
    );
    execFileSync("bun", ["install", "--ignore-scripts"], { cwd: source, stdio: "pipe" });
    for (const file of ["package.json", "bun.lock"]) cpSync(join(source, file), join(cold, file));
    omitReleaseLifecycles(cold);
    const lock = readFileSync(join(cold, "bun.lock"), "utf8");
    execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: cold, stdio: "pipe" });
    assert.equal(readFileSync(join(cold, "bun.lock"), "utf8"), lock);
    const require = createRequire(join(cold, "package.json"));
    assert.equal(existsSync(join(require.resolve("dugite/package.json"), "../git/bin/git")), false);
    assert.equal(existsSync(join(require.resolve("electron/package.json"), "../dist")), false);
    await assert.rejects(
      require("dugite").exec(["--version"], cold),
      /ENOENT|not found|Unable to find/,
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["-e", 'require("node:child_process").execFileSync(require("electron"), ["--version"])'],
          {
            cwd: cold,
            env: { ...process.env, ...checkRuntimeEnvironment(cold) },
            stdio: "pipe",
          },
        ),
      /ENOENT/,
    );
    assert.equal(
      require("esbuild").transformSync("let value: number = 1", { loader: "ts" }).code,
      "let value = 1;\n",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(cold, "package.json"), "utf8")).trustedDependencies,
      ["esbuild"],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(source, "package.json"), "utf8")).trustedDependencies,
      ["dugite", "electron", "esbuild"],
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("desktop asset versions survive unrelated dependency changes and separate platforms", () => {
  const lock = readFileSync(new URL("../clients/desktop/bun.lock", import.meta.url), "utf8");
  const key = desktopAssetKey(lock, "linux-x64");
  assert.equal(desktopAssetKey(lock.replaceAll("react@19.2.6", "react@19.2.7"), "linux-x64"), key);
  assert.notEqual(
    desktopAssetKey(lock.replaceAll("electron@44.4.5", "electron@44.4.6"), "linux-x64"),
    key,
  );
  assert.notEqual(
    desktopAssetKey(
      lock.replaceAll("app-builder-lib@26.15.6", "app-builder-lib@26.15.7"),
      "linux-x64",
    ),
    key,
  );
  assert.notEqual(desktopAssetKey(lock, "win32-x64"), key);
  assert.throws(() => desktopAssetKey("{}", "linux-x64"), /locked electron version/);
});

test("Check does not invoke upstream release packaging that requires the omitted runtimes", () => {
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.env.BASALT_CI_OMIT_RELEASE_DOWNLOADS, "true");
  for (const [id, job] of Object.entries(workflow.jobs) as [
    string,
    { steps: { run?: string }[] },
  ][]) {
    for (const step of job.steps) {
      assert.doesNotMatch(
        step.run ?? "",
        /(?:scripts\/releases\/|bun run releases?:|bun run desktop:|bunx electron|electron\/cli\.js|e2e:desktop)/,
        id,
      );
    }
  }
  const upstream = new URL("../.upstream/", import.meta.url);
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: upstream, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  const references = files.filter(
    (file) =>
      existsSync(new URL(file, upstream)) &&
      /(?:from\s+["']dugite["']|require\(["']dugite["']\))/.test(
        readFileSync(new URL(file, upstream), "utf8"),
      ),
  );
  assert.ok(references.length);
  for (const file of references) assert.match(file, /^scripts\/releases\//);
  const electronReferences = files.filter(
    (file) =>
      existsSync(new URL(file, upstream)) &&
      /(?:from\s+["']electron["']|require\(["']electron["']\))/.test(
        readFileSync(new URL(file, upstream), "utf8"),
      ),
  );
  assert.ok(electronReferences.length);
  for (const file of electronReferences) assert.match(file, /^apps\/local\/desktop\//);
  assert.deepEqual(releaseOnlyDependencies, ["dugite", "electron"]);
});

test("the CI guard refuses release hosts for fetch, HTTP and direct socket resolution", () => {
  const guard = new URL("./ci/deny-release-downloads.cjs", import.meta.url).pathname;
  execFileSync(
    process.execPath,
    [
      "--require",
      guard,
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import https from 'node:https';
    import dns from 'node:dns';
    const blocked = /Blocked GitHub release asset host/;
    await assert.rejects(fetch('https://github.com/example/releases/download/v1/asset'), blocked);
    assert.throws(() => https.get('https://release-assets.githubusercontent.com/asset'), blocked);
    assert.throws(() => dns.lookup('objects.githubusercontent.com', () => {}), blocked);
    await assert.rejects(dns.promises.lookup('github.com'), blocked);
    assert.equal(await (await fetch('data:text/plain,allowed')).text(), 'allowed');
  `,
    ],
    { stdio: "pipe" },
  );
});
