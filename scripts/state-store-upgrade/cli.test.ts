import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { workerId } from "./plan.ts";

function run(mode?: string, expected = false, drift = false, providerFailure = false) {
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
const f=fixture();
if (${JSON.stringify(drift)}) {
  f.hooks.read = count => {
    if (count === 11) {
      f.state.bindings[1].text = "changed-private-binding";
      f.state.settings.compatibility_flags = ["private-flag-one", "private-flag-two"];
      f.state.settings.annotations = {
        "workers/message": "private-annotation-message",
        "workers/tag": "private-annotation-tag",
      };
    }
  };
  process.env.STATE_UPGRADE_MODE = "apply";
  for (const [name, value] of Object.entries({
    WORKER_ID: f.expected.workerId, DEPLOYMENT_ID: f.expected.deploymentId,
    NAMESPACE_ID: f.expected.namespaceId, VERSION: f.expected.version,
    PLAN_SHA256: f.expected.planSha256,
  })) process.env["STATE_UPGRADE_EXPECTED_" + name] = value;
}
globalThis.fetch=${JSON.stringify(providerFailure)}
  ? async () => Response.json({ success: false, errors: [{code: 10021, message: 'Invalid metadata field observability. Bearer never-log-provider-token {"password":"short-value"} Cookie: session=tiny'}], messages: [{message: "Use version metadata only."}] }, {status: 400})
  : f.fetcher;
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
  assert.equal(result.receipt.plan.upload.method, "POST");
  assert.equal(result.receipt.plan.upload.metadata.main_module, "Api.js");
  assert.equal(result.receipt.plan.upload.query.bindings_inherit, "strict");
  assert.ok(!("observability" in result.receipt.plan.upload.metadata));
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

test("CLI error and summary both name all binding differences without exposing contents", () => {
  const result = run(undefined, false, true);
  assert.equal(result.status, 1);
  for (const text of [result.stderr, result.summary]) {
    assert.match(text, /PRIVATE_VALUE: text expected sha256:[a-f0-9]+, observed sha256:[a-f0-9]+/);
    assert.match(text, /annotations.workers\/message expected absent, observed sha256:[a-f0-9]+/);
    assert.match(text, /annotations.workers\/tag expected absent, observed sha256:[a-f0-9]+/);
    assert.match(
      text,
      /compatibility_flags.0 expected sha256:[a-f0-9]+, observed sha256:[a-f0-9]+/,
    );
    assert.match(text, /compatibility_flags.1 expected absent, observed sha256:[a-f0-9]+/);
    assert.ok(!text.includes("private-flag-one"));
    assert.ok(!text.includes("private-flag-two"));
    assert.ok(!text.includes("private-annotation-message"));
    assert.ok(!text.includes("private-annotation-tag"));
    assert.ok(!text.includes("changed-private-binding"));
    assert.ok(!text.includes("never-print-this-binding-value"));
  }
  assert.ok(result.requests.every((request) => request.method === "GET"));
});

test("CLI receipt, error and summary retain sanitized provider causes", () => {
  const result = run(undefined, false, false, true);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.error.provider.errors[0].code, 10021);
  for (const text of [result.stderr, result.summary, JSON.stringify(result.receipt)]) {
    assert.match(text, /Invalid metadata field observability/);
    assert.match(text, /Use version metadata only/);
    assert.ok(!text.includes("never-log-provider-token"));
    assert.ok(!text.includes("short-value"));
    assert.ok(!text.includes("session=tiny"));
  }
});
