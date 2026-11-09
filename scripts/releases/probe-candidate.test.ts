import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProbeCandidate } from "../ci/probe-candidate.ts";

function repository(context: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "probe-candidate-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-b", "main");
  writeFileSync(join(root, "retirements.json"), "[]");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-c", "feature");
  writeFileSync(join(root, "probe.txt"), "fixed reader");
  git("add", ".");
  git("commit", "-m", "probe fix");
  const head = git("rev-parse", "HEAD");
  git("switch", "main");
  writeFileSync(join(root, "retirements.json"), '["standalone-gitlab-mcp"]');
  git("add", ".");
  git("commit", "-m", "retire source");
  const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  return { root, git, base, head, main };
}

test("the probe candidate includes current main retirements absent from the PR head", (context) => {
  const fixture = repository(context);
  fixture.git("merge", "--no-ff", "feature", "-m", "current main plus PR");
  const receipt = assertProbeCandidate(fixture.root, fixture.head);
  assert.equal(receipt.main, fixture.main);
  assert.equal(receipt.head, fixture.head);
  assert.equal(
    readFileSync(join(fixture.root, "retirements.json"), "utf8"),
    '["standalone-gitlab-mcp"]',
  );
  assert.equal(readFileSync(join(fixture.root, "probe.txt"), "utf8"), "fixed reader");
});

test("the probe refuses the PR head without current main", (context) => {
  const fixture = repository(context);
  fixture.git("switch", "feature");
  assert.throws(() => assertProbeCandidate(fixture.root, fixture.head), /requires current main/);
});

test("an older merge against the PR base cannot stand in for current main", (context) => {
  const fixture = repository(context);
  fixture.git("checkout", "--detach", fixture.base);
  fixture.git("merge", "--no-ff", "feature", "-m", "old base plus PR");
  assert.throws(() => assertProbeCandidate(fixture.root, fixture.head), /requires current main/);
});
