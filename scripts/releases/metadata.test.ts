import assert from "node:assert/strict";
import test from "node:test";
import { reconcileLabels, reconcileMetadata, updateSafetySection } from "./metadata.ts";
import { pins, sha } from "./fixtures.test-helpers.ts";
import type { ClassificationReport } from "./types.ts";

test("keeps release provenance and adds the applicable machine-owned risk labels", () => {
  const report = classified(true, true);
  const result = reconcileLabels(["triage"], [], report, "none");
  assert.deepEqual(result.labels, ["database-change", "manual-release", "release-update", "triage", "workflow-identity-change"]);
  assert.deepEqual(result.managedRiskLabels, ["database-change", "manual-release", "workflow-identity-change"]);
});

test("removes only previously machine-owned stale risk labels on a clear rerun", () => {
  const result = reconcileLabels(
    ["release-update", "manual-release", "database-change", "workflow-identity-change", "triage"],
    ["manual-release", "database-change", "workflow-identity-change"],
    classified(false, false),
    "machine",
  );
  assert.deepEqual(result.labels, ["release-update", "triage"]);
  assert.deepEqual(result.removed, ["database-change", "manual-release", "workflow-identity-change"]);
});

test("keeps a manual-release label when a human hold is present or ownership is unknown", () => {
  for (const ownership of ["human", "unknown"] as const) {
    const result = reconcileLabels(
      ["release-update", "manual-release"],
      ["manual-release"],
      classified(false, false),
      ownership,
    );
    assert.ok(result.labels.includes("manual-release"));
    assert.equal(result.removed.includes("manual-release"), false);
  }
});

test("replaces only the marked safety section and preserves unrelated body edits", () => {
  const original = "Maintainer notes stay here.\n\n<!-- basalt-release-safety:start -->old<!-- basalt-release-safety:end -->\n\nMore notes.";
  const result = updateSafetySection(original, classified(true, false), ["manual-release", "database-change"], "machine");
  assert.ok(result.startsWith("Maintainer notes stay here."));
  assert.ok(result.endsWith("More notes."));
  assert.match(result, /Database change: unknown/);
  assert.match(result, /Workflow identity change: clear/);
  assert.equal((result.match(/<!-- basalt-release-safety:start -->/g) ?? []).length, 1);
});

test("refuses ambiguous safety-section markers", () => {
  assert.throws(() => updateSafetySection("<!-- basalt-release-safety:start -->broken", classified(false, false), [], "none"), /markers are invalid/);
});

test("uses the prior marked section to remove only machine-owned risk labels", () => {
  const report = classified(false, false);
  const existingBody = updateSafetySection("Keep these notes.", classified(true, true), ["manual-release", "database-change", "workflow-identity-change"], "machine");
  const result = reconcileMetadata({
    currentLabels: ["release-update", "manual-release", "database-change", "workflow-identity-change"],
    existingBody,
    report,
    manualHoldOwnership: "machine",
  });
  assert.deepEqual(result.labels, ["release-update"]);
  assert.deepEqual(result.removed, ["database-change", "manual-release", "workflow-identity-change"]);
  assert.ok(result.body.startsWith("Keep these notes."));
});

function classified(databaseChanged: boolean, workflowChanged: boolean): ClassificationReport {
  const source = {
    name: "tools",
    state: databaseChanged || workflowChanged ? "unknown" as const : "unchanged" as const,
    base: sha("a"),
    candidate: sha("b"),
    changedPaths: databaseChanged ? ["apps/hosted/cloud/src/database.ts"] : [],
    ...(databaseChanged || workflowChanged ? { reason: "source comparison incomplete" } : {}),
  };
  const snapshot = pins();
  return {
    schemaVersion: 1,
    base: { gitCommit: sha("1"), pins: snapshot },
    candidate: { gitCommit: sha("2"), pins: snapshot },
    databaseChanged,
    workflowChanged,
    evidence: {
      database: { state: databaseChanged ? "unknown" : "unchanged", sources: databaseChanged ? [source] : [] },
      workflow: { state: workflowChanged ? "unknown" : "unchanged", sources: workflowChanged ? [source] : [] },
    },
  };
}
