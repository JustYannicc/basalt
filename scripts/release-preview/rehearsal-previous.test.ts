import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitPreviousCandidate } from "./rehearsal-previous.ts";
import { rehearsalNumber, rehearsalScenario } from "./rehearsal-stage.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

test("the previous candidate is the candidate with the pool source from before its last pin change", (t) => {
  const root = mkdtempSync(join(tmpdir(), "basalt-previous-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "containers/pool"), { recursive: true });
  git(root, "init", "-q", repo);
  const write = (path: string, value: string) => writeFileSync(join(repo, path), value);
  write("containers/pool/releases.json", '{"node":"v1"}');
  write("containers/pool/patch.diff", "old patch");
  write("app.ts", "app 1");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  write("containers/pool/releases.json", '{"node":"v2"}');
  write("containers/pool/patch.diff", "new patch");
  git(repo, "commit", "-q", "-am", "pin");
  write("app.ts", "app 2");
  git(repo, "commit", "-q", "-am", "candidate");
  const candidate = git(repo, "rev-parse", "HEAD");

  const destination = join(root, "previous");
  const { baseline, previous } = commitPreviousCandidate(repo, destination);
  // Three distinct commits, as production has: an older baseline, the previous candidate, this one.
  assert.equal(new Set([baseline, previous, candidate]).size, 3);
  assert.equal(git(destination, "rev-parse", "HEAD"), baseline);
  assert.equal(git(destination, "rev-parse", "HEAD^"), candidate);
  assert.equal(git(destination, "rev-parse", `${previous}^`), baseline);
  assert.equal(git(destination, "diff", "--name-only", baseline, previous), "");
  assert.equal(readFileSync(join(destination, "containers/pool/releases.json"), "utf8"), '{"node":"v1"}');
  assert.equal(readFileSync(join(destination, "containers/pool/patch.diff"), "utf8"), "old patch");
  assert.equal(readFileSync(join(destination, "app.ts"), "utf8"), "app 2");
  assert.deepEqual(git(destination, "diff", "--name-only", "HEAD^", "HEAD").split("\n").sort(), [
    "containers/pool/patch.diff",
    "containers/pool/releases.json",
  ]);
  assert.throws(() => commitPreviousCandidate(repo, destination), /already exists/);
});

test("each run, attempt and scenario gets its own rehearsal stage number", () => {
  assert.equal(rehearsalNumber("812", "1", rehearsalScenario("straight")), 81211);
  assert.equal(rehearsalNumber("812", "1", rehearsalScenario("drain-resume")), 81212);
  assert.equal(rehearsalNumber("812", "2", rehearsalScenario("straight")), 81221);
  assert.throws(() => rehearsalNumber("0", "1", "straight"), /run number/);
  assert.throws(() => rehearsalNumber(undefined, "1", "straight"), /run number/);
  assert.throws(() => rehearsalNumber("812", "10", "straight"), /attempt/);
  assert.throws(() => rehearsalNumber("812", undefined, "straight"), /attempt/);
  assert.throws(() => rehearsalScenario("chaos"), /Unknown/);
});

test("a single-change rehearsal's baseline is its merge candidate's first parent", async (t) => {
  const { checkoutChangeBaseline } = await import("./rehearsal-previous.ts");
  const root = mkdtempSync(join(tmpdir(), "basalt-change-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "branch", repo);
  writeFileSync(join(repo, "a.ts"), "1");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "fix");
  writeFileSync(join(repo, "b.ts"), "fix");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fix");
  git(repo, "checkout", "-q", "branch");
  writeFileSync(join(repo, "c.ts"), "rehearsal");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "rehearsal");
  const rehearsal = git(repo, "rev-parse", "HEAD");
  assert.throws(() => checkoutChangeBaseline(repo, join(root, "early")), /merge candidate/);
  git(repo, "merge", "-q", "--no-edit", "fix");
  assert.notEqual(base, rehearsal);
  assert.equal(checkoutChangeBaseline(repo, join(root, "baseline")), rehearsal);
  assert.equal(readFileSync(join(root, "baseline", "c.ts"), "utf8"), "rehearsal");
  assert.throws(() => readFileSync(join(root, "baseline", "b.ts")));
});
