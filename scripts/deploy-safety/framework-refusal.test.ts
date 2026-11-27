import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SafetyGateError } from "./contracts.ts";
import { frameworkDifferences, refuseFramework } from "./framework-refusal.ts";

test("framework refusals name every changed identity and field in job errors and the step summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-framework-refusal-"));
  const summary = join(directory, "summary.md");
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  const release = {
    version: "synthetic-release",
    sha256: "1".repeat(64),
    protocol: 44,
    browserSha256: "2".repeat(64),
    source: { origin: "basalt" as const, revision: "source", sha256: "3".repeat(64) },
  };
  try {
    let diagnostic = "";
    assert.throws(
      () =>
        refuseFramework(
          "Framework producer differs",
          frameworkDifferences(
            "framework producer",
            { ...release, browserSha256: "4".repeat(64) },
            { ...release, source: { ...release.source, revision: "changed" } },
          ),
        ),
      (error) => {
        assert.ok(error instanceof SafetyGateError);
        diagnostic = error.message;
        assert.match(diagnostic, /"framework producer" browserSha256/);
        assert.ok(
          diagnostic.includes(`expected "${"4".repeat(64)}"; observed "${"2".repeat(64)}"`),
        );
        assert.match(
          diagnostic,
          /"framework producer" source\.revision: expected "source"; observed "changed"/,
        );
        return true;
      },
    );
    assert.ok(readFileSync(summary, "utf8").includes(diagnostic));
  } finally {
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
    rmSync(directory, { recursive: true, force: true });
  }
});
