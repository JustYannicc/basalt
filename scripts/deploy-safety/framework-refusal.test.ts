import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SafetyGateError } from "./contracts.ts";
import {
  qualifiedFrameworkRegistry,
  renderQualifiedFrameworkRegistry,
  validateFrameworkBuildReceipt,
} from "./framework-registry.ts";

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
  const candidate = "a".repeat(40);
  const receipt = qualifiedFrameworkRegistry([], [], release, candidate);
  const generated = renderQualifiedFrameworkRegistry(receipt.releases);
  try {
    let diagnostic = "";
    assert.throws(
      () =>
        validateFrameworkBuildReceipt(
          receipt,
          candidate,
          { ...release, browserSha256: "4".repeat(64) },
          [],
          [],
          generated,
        ),
      (error) => {
        assert.ok(error instanceof SafetyGateError);
        diagnostic = error.message;
        assert.match(diagnostic, /framework producer.*browserSha256/);
        assert.ok(
          diagnostic.includes(`expected "${"4".repeat(64)}"; observed "${"2".repeat(64)}"`),
        );
        assert.match(diagnostic, /basalt-qualified-framework-releases.ts.*sourceSha256/);
        return true;
      },
    );
    assert.ok(readFileSync(summary, "utf8").includes(diagnostic));

    const earlier = qualifiedFrameworkRegistry(
      [],
      [],
      {
        ...release,
        version: "earlier-release",
        sha256: "5".repeat(64),
      },
      "b".repeat(40),
    );
    assert.throws(
      () =>
        validateFrameworkBuildReceipt(
          receipt,
          candidate,
          release,
          [],
          [earlier.qualification],
          generated,
        ),
      (error) => {
        assert.ok(error instanceof SafetyGateError);
        assert.ok(error.message.includes(`earlier-release/${"5".repeat(64)}`));
        assert.match(error.message, /qualified identity: expected "present"; observed "absent"/);
        assert.match(error.message, /qualification.registrySha256/);
        assert.ok(readFileSync(summary, "utf8").includes(error.message));
        return true;
      },
    );
  } finally {
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
    rmSync(directory, { recursive: true, force: true });
  }
});
