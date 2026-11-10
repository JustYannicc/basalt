import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import { executorMarkerPolicy, executorMarkerPrecondition } from "./executor-marker.ts";

const oldToolsPin = "f69c667936e4c02c75f9d7cc79fb750c230839b9";
const stage2ToolsPin = "2f4c398f3906e0570f0e25a16fa3602329baba29";

const pins = (toolsCommit: string): ReleasePins => ({
  tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: toolsCommit },
  home: {
    repository: "https://github.com/router-for-me/CLIProxyAPIHome.git",
    tag: "v1",
    commit: "c".repeat(40),
    binary: "home",
    assets: {
      amd64: { name: "amd64", sha256: "1".repeat(64) },
      arm64: { name: "arm64", sha256: "2".repeat(64) },
    },
  },
  node: {
    repository: "https://github.com/router-for-me/CLIProxyAPI.git",
    tag: "v1",
    commit: "d".repeat(40),
    binary: "node",
    assets: {
      amd64: { name: "amd64", sha256: "3".repeat(64) },
      arm64: { name: "arm64", sha256: "4".repeat(64) },
    },
  },
});

const report = (
  baseCommit: string,
  candidateCommit: string,
  baseTools: string,
  candidateTools: string,
  databaseChanged = true,
): ClassificationReport => ({
  schemaVersion: 1,
  base: { gitCommit: baseCommit, pins: pins(baseTools) },
  candidate: { gitCommit: candidateCommit, pins: pins(candidateTools) },
  databaseChanged,
  workflowChanged: false,
  evidence: {
    database: { state: databaseChanged ? "changed" : "unchanged", sources: [] },
    workflow: { state: "unchanged", sources: [] },
  },
});

test("the approved tools-pin transition selects Stage 2 without pinning the self-referential Git SHA", () => {
  const current = report("a".repeat(40), "b".repeat(40), oldToolsPin, stage2ToolsPin);
  const retry = report("c".repeat(40), "d".repeat(40), oldToolsPin, stage2ToolsPin);
  const currentGate = executorMarkerPrecondition(current);
  const retryGate = executorMarkerPrecondition(retry);
  assert.equal(currentGate?.expected, "4.0.29");
  assert.equal(currentGate?.transition.baseGitCommit, current.base.gitCommit);
  assert.equal(currentGate?.transition.candidateGitCommit, current.candidate.gitCommit);
  assert.equal(retryGate?.transition.baseGitCommit, retry.base.gitCommit);
  assert.equal(retryGate?.transition.candidateGitCommit, retry.candidate.gitCommit);
});

test("fresh bootstrap and later transitions do not inherit the one-time Stage 2 gate", () => {
  const fresh = report("b".repeat(40), "b".repeat(40), stage2ToolsPin, stage2ToolsPin);
  const later = report("b".repeat(40), "e".repeat(40), stage2ToolsPin, "9".repeat(40));
  const unrelated = report("a".repeat(40), "b".repeat(40), oldToolsPin, stage2ToolsPin, false);
  assert.equal(executorMarkerPrecondition(fresh), undefined);
  assert.equal(executorMarkerPrecondition(later), undefined);
  assert.equal(executorMarkerPrecondition(unrelated), undefined);
});

test("the serialized production policy is candidate-bound and explicitly clears an unrelated cutover", () => {
  const candidate = "b".repeat(40);
  const selected = executorMarkerPrecondition(report("a".repeat(40), candidate, oldToolsPin, stage2ToolsPin));
  assert.deepEqual(JSON.parse(executorMarkerPolicy(candidate, selected)), { candidate, precondition: selected });
  assert.deepEqual(JSON.parse(executorMarkerPolicy(candidate)), { candidate, precondition: null });
  assert.throws(() => executorMarkerPolicy("c".repeat(40), selected), /does not match/);
  assert.throws(() => executorMarkerPolicy("main"), /immutable/);
});
