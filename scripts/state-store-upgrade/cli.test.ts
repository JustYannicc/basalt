import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { workerId } from "./plan.ts";

function run(mode?: string, expected = false) {
  const root = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "state-upgrade-cli-"));
  const bundle = join(directory, "bundle");
  mkdirSync(bundle);
  writeFileSync(join(bundle, "Api.js"), "export default {}");
  writeFileSync(
    join(bundle, "upgrade-bundle.json"),
    JSON.stringify({
      main: "Api.js",
      files: ["Api.js"],
      compatibility: { date: "2026-08-31", flags: ["new_module_registry"] },
    }),
  );
  const preload = join(directory, "preload.mjs");
  writeFileSync(
    preload,
    `
import { fixture } from ${JSON.stringify(pathToFileURL(join(root, "scripts/state-store-upgrade/fixture.ts")).href)};
import { writeFileSync } from 'node:fs';
const f=fixture();globalThis.fetch=f.fetcher;
process.on('exit',()=>writeFileSync(${JSON.stringify(join(directory, "requests.json"))},JSON.stringify(f.requests)));
`,
  );
  const env: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "never-log-provider-token",
    STATE_UPGRADE_OUTPUT_DIRECTORY: join(directory, "output"),
    STATE_UPGRADE_BUNDLE_DIRECTORY: bundle,
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
    ...(mode === undefined ? {} : { STATE_UPGRADE_MODE: mode }),
    ...(expected ? { STATE_UPGRADE_EXPECTED_WORKER_ID: workerId } : {}),
  };
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", preload, "scripts/state-store-upgrade/run.ts"],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      receipt: JSON.parse(readFileSync(join(directory, "output/receipt.json"), "utf8")),
      summary: readFileSync(join(directory, "summary.md"), "utf8"),
      requests: JSON.parse(readFileSync(join(directory, "requests.json"), "utf8")) as {
        method: string;
        url: string;
      }[],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("the real CLI defaults to a read-only plan and retains the complete safe receipt", () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.equal(result.receipt.mode, "dry-run");
  assert.equal(result.receipt.phase, "planned");
  assert.ok(result.requests.length > 0);
  assert.ok(result.requests.every((request) => request.method === "GET"));
  assert.equal(JSON.parse(result.stdout).planSha256, result.receipt.planSha256);
  assert.match(result.summary, /No Secrets Store resource is created, updated or deleted/);
  for (const text of [
    result.stdout,
    result.stderr,
    result.summary,
    JSON.stringify(result.receipt),
  ]) {
    assert.ok(!text.includes("never-log-provider-token"));
    assert.ok(!text.includes("never-print-this-binding-value"));
  }
});
test("the real CLI refuses incomplete apply inputs and leaves an inspectable receipt", () => {
  const result = run("apply", true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /input-deployment-id expected explicit valid input/);
  assert.equal(result.receipt.error.property, "input-deployment-id");
  assert.ok(result.requests.every((request) => request.method === "GET"));
});
test("a malformed mode makes no provider request and still leaves a failure receipt", () => {
  const result = run("destroy");
  assert.equal(result.status, 1);
  assert.equal(result.receipt.phase, "preflight");
  assert.equal(result.receipt.error.property, "mode");
  assert.deepEqual(result.requests, []);
});
