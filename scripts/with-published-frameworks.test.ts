import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { frameworkIdentity } from "../.upstream/packages/sdk/src/implementation/framework-identity.ts";
import { publishedFrameworkFixtures } from "./ci/with-published-frameworks.ts";

async function localFrameworkFixture() {
  const root = mkdtempSync(join(tmpdir(), "published-frameworks-"));
  mkdirSync(join(root, "e2e"));
  mkdirSync(join(root, ".local/test-runtime"), { recursive: true });
  mkdirSync(join(root, "package"));
  writeFileSync(
    join(root, "e2e/npm-packages.json"),
    JSON.stringify({ packages: { apps: { versions: {} } } }),
  );
  const runtime = {
    version: "test-current-framework",
    protocol: 44,
    server: { "server.js": "export const server = 1;" },
    browser: { "browser.js": "export const browser = 1;" },
  };
  const identity = await Effect.runPromise(
    frameworkIdentity({ version: runtime.version, modules: runtime.server }),
  );
  const browserIdentity = await Effect.runPromise(
    frameworkIdentity({ version: runtime.version, modules: runtime.browser }),
  );
  const approved = {
    ...identity,
    protocol: runtime.protocol,
    browserSha256: browserIdentity.sha256,
  };
  const pack = () => {
    writeFileSync(join(root, "package/runtime.json"), JSON.stringify(runtime));
    execFileSync("tar", [
      "-czf",
      join(root, ".local/test-runtime/apps.tgz"),
      "-C",
      root,
      "package/runtime.json",
    ]);
  };
  return { root, runtime, approved, pack };
}

test("published framework adapter accepts an archive matching the approved tuple", async () => {
  const fixture = await localFrameworkFixture();
  try {
    fixture.pack();
    const adapters = await publishedFrameworkFixtures(fixture.root, [fixture.approved]);
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].version, "synthetic-e2e-protocol26");
    assert.equal(adapters[0].protocol, 26);
    assert.equal(adapters[0].sha256, fixture.approved.sha256);
    assert.equal(adapters[0].browserSha256, fixture.approved.browserSha256);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("published framework adapter rejects changed browser bytes in an otherwise approved archive", async () => {
  const fixture = await localFrameworkFixture();
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  const summary = join(fixture.root, "summary.md");
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    fixture.runtime.browser["browser.js"] = "export const browser = 2;";
    const observedBrowser = await Effect.runPromise(
      frameworkIdentity({ version: fixture.runtime.version, modules: fixture.runtime.browser }),
    );
    fixture.pack();
    await assert.rejects(publishedFrameworkFixtures(fixture.root, [fixture.approved]), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /must start from an approved current framework/);
      assert.ok(error.message.includes(join(fixture.root, ".local/test-runtime/apps.tgz")));
      assert.ok(error.message.includes(fixture.approved.browserSha256));
      assert.ok(error.message.includes(observedBrowser.sha256));
      assert.equal(readFileSync(summary, "utf8"), `${error.message}\n`);
      return true;
    });
  } finally {
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
