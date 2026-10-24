import assert from "node:assert/strict";
import { test } from "node:test";
import { impactPaths, validateReleaseClassification } from "./classification.ts";

const base = "a".repeat(40);
const candidate = "b".repeat(40);
const pins = {
  tools: { repository: "UsefulSoftwareCo/executor", commit: "1".repeat(40) },
  home: { repository: "router-for-me/CLIProxyAPIHome", tag: "v1.2.3", commit: "2".repeat(40), binary: "cli-proxy-api", assets: {} },
  node: { repository: "router-for-me/CLIProxyAPI", tag: "v1.2.3", commit: "3".repeat(40), binary: "cli-proxy-api", assets: {} },
};

function report(database: "unchanged" | "changed" | "unknown" = "unchanged", workflow: "unchanged" | "changed" | "unknown" = "unchanged") {
  const evidence = (state: typeof database | typeof workflow, path: string) => ({
    state,
    sources: [{ name: "source", state, base, candidate, changedPaths: state === "unchanged" ? [] : [path] }],
  });
  return {
    schemaVersion: 1 as const,
    base: { gitCommit: base, pins },
    candidate: { gitCommit: candidate, pins },
    databaseChanged: database !== "unchanged",
    workflowChanged: workflow !== "unchanged",
    evidence: {
      database: evidence(database, "src/db/migration.sql"),
      workflow: evidence(workflow, "apps/hosted/workflow.ts"),
    },
  };
}

test("safe classification requires exact current base and candidate SHAs", () => {
  const result = validateReleaseClassification(report(), { base, candidate });
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.decision, { databaseChanged: false, workflowChanged: false, labels: [] });
  assert.match(validateReleaseClassification(report(), { base: "c".repeat(40), candidate }).reasons.join(" "), /does not cover/);
});

test("changed and unknown impacts both produce manual risk labels", () => {
  assert.deepEqual(validateReleaseClassification(report("changed", "unchanged"), { base, candidate }).decision?.labels, ["database-change", "manual-release"]);
  assert.deepEqual(validateReleaseClassification(report("unchanged", "unknown"), { base, candidate }).decision?.labels, ["workflow-identity-change", "manual-release"]);
});

test("rejects inconsistent flags, unknown schema fields, and missing evidence", () => {
  const inconsistent = report("unknown");
  inconsistent.databaseChanged = false;
  assert.match(validateReleaseClassification(inconsistent, { base, candidate }).reasons.join(" "), /flags do not match/);
  assert.ok(validateReleaseClassification({ ...report(), privatePath: "/tmp/fixture" }, { base, candidate }).reasons.length > 0);
  assert.ok(validateReleaseClassification({ ...report(), evidence: { database: report().evidence.database } }, { base, candidate }).reasons.length > 0);
});

test("source paths exclude traversal and formatting injection", () => {
  const evidence = report("changed").evidence.database;
  evidence.sources[0]!.changedPaths = ["src/db/schema.ts", "../private", "src/ok`\n- forged", "/local/file"];
  assert.deepEqual(impactPaths(evidence), ["src/db/schema.ts"]);
});

