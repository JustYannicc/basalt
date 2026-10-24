import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentCommit } from "./release-plan.ts";

test("candidate SHA comes from checked-out HEAD, not workflow_dispatch GITHUB_SHA", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-candidate-sha-"));
  const prior = {
    githubSha: process.env.GITHUB_SHA,
    candidateSha: process.env.BASALT_RELEASE_CANDIDATE_SHA,
  };
  try {
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
    execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "candidate.txt"), "candidate\n");
    execFileSync("git", ["-C", root, "add", "candidate.txt"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "candidate"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    process.env.GITHUB_SHA = "f".repeat(40);
    process.env.BASALT_RELEASE_CANDIDATE_SHA = head;
    assert.equal(currentCommit(root), head);
    process.env.BASALT_RELEASE_CANDIDATE_SHA = "e".repeat(40);
    assert.throws(() => currentCommit(root), /does not match the checked-out HEAD/);
  } finally {
    restore("GITHUB_SHA", prior.githubSha);
    restore("BASALT_RELEASE_CANDIDATE_SHA", prior.candidateSha);
    rmSync(root, { recursive: true, force: true });
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
