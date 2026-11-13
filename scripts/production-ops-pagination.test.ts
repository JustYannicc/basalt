import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the workflow operator retains each encrypted page before continuing and stops on the first named refusal", () => {
  const directory = mkdtempSync(join(tmpdir(), "retained-inventory-pages-"));
  const fixture = join(directory, "fetch.mjs");
  const summary = join(directory, "step-summary");
  const poison = "private-provider-message";
  writeFileSync(
    fixture,
    `let calls = 0;
globalThis.fetch = async () => {
  const index = calls++;
  if (index === 0) return Response.json({
    action: 'inventory',
    artifact: {sha256: '${"a".repeat(64)}', recipient: {ciphertext: 'encrypted'}},
    pagination: {index, session: 'fixture', more: true, complete: true, builds: 64, references: 64},
    continuation: {version: 1, sha256: '${"b".repeat(64)}', sealed: {}, recipient: {}}
  });
  if (index === 1) return Response.json({failure: {
    format: 'basalt-production-ops-failure-v1', category: 'refused', phase: 'sql',
    reasonCode: 'snapshot_changed', message: '${poison}'
  }}, {status: 409});
  throw new Error('The operator repeated a refused request');
};
process.on('exit', () => { if (calls !== 2) process.exitCode = 99; });`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", fixture, "scripts/production-ops/run.ts"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REF: "refs/heads/main",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          POOL_APP_SIGNING_KEY: "ab".repeat(32),
          OPS_ACTION: "inventory",
          OPS_SELECTION: "retained-frameworks",
          OPS_REQUEST: '{"organization":"org_fixture"}',
          OPS_RECIPIENT: "c3ludGhldGlj",
          OPS_OUTPUT_DIRECTORY: directory,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.deepEqual(readdirSync(join(directory, "pages")), ["00000.json"]);
    const receipt = readFileSync(join(directory, "failure.json"), "utf8");
    assert.equal(JSON.parse(receipt).reasonCode, "snapshot_changed");
    assert.ok(!readdirSync(directory).includes("operation.json"));
    const text = `${result.stdout}${result.stderr}${receipt}${readFileSync(summary, "utf8")}`;
    assert.match(result.stderr, /snapshot_changed/);
    assert.match(readFileSync(summary, "utf8"), /snapshot_changed/);
    assert.ok(!text.includes(poison));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
