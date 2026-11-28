import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { batchFiles, comparisonBase, shipAlone } from "./ship-alone.ts";
import { git, measured } from "./test/history.ts";

// Files a merge into main brought in, compared with main before it.
const merged = (sha: string) =>
  git(["diff", "--name-only", "--no-renames", `${sha}^1`, sha])
    .split("\n")
    .filter(Boolean);

test("refuses the 16 Nov batch that replaced the release path alongside pool features", () => {
  const result = shipAlone(merged("dae3b3278"), measured);
  assert.equal(result.pass, false);
  assert.equal(result.releasePath.length, 127);
  assert.ok(result.other.some((file) => file.startsWith("src/pool/")));
});

test("passes a release fix that touches only the release path, its carries model and docs", () => {
  // 42c7cfe5 (#1272) changed the release barrier, its Alchemy carry and docs/releases.md.
  assert.equal(shipAlone(merged("42c7cfe5b"), measured).pass, true);
});

test("passes product changes and release-path changes on their own", () => {
  assert.equal(shipAlone(["src/pool/worker.ts", "docs/pools.md"]).pass, true);
  assert.equal(shipAlone(["scripts/release/deploy.ts", "architecture/model/x.c4"]).pass, true);
  assert.equal(
    shipAlone(["scripts/release/deploy.ts", "tsconfig.json", "package.json"]).pass,
    true,
  );
  assert.equal(shipAlone(["scripts/release/deploy.ts", "src/pool/worker.ts"]).pass, false);
});

test("a change that drops a path from the list is still judged by the list it changes", () => {
  const narrowed = measured.filter((path) => path !== "scripts/release-barrier/**");
  const files = ["scripts/release-barrier/entry.ts", "src/pool/worker.ts"];
  assert.equal(shipAlone(files, narrowed).pass, true);
  assert.equal(shipAlone(files, [...new Set([...narrowed, ...measured])]).pass, false);
});

test("a stacked batch is judged from the batch below it until that batch is on main", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ship-alone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A clean git: no hooks, signing or GIT_* variables from whatever runs the test.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const config = [
    "user.name=t",
    "user.email=t@t",
    "commit.gpgsign=false",
    "core.hooksPath=/dev/null",
  ];
  const run = (...args: string[]) =>
    execFileSync("git", [...config.flatMap((value) => ["-c", value]), ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    }).trim();
  const commit = (file: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), file);
    run("add", file);
    run("commit", "-qm", file);
    return run("rev-parse", "HEAD");
  };
  run("init", "-q", "-b", "main");
  const main = commit("README.md");
  const lower = commit("src/pool/worker.ts");
  const upper = commit("scripts/release/deploy.ts");
  const paths = ["scripts/release/**"];
  const judged = (main: string, ref: string, head = upper) =>
    shipAlone(batchFiles(main, comparisonBase(main, head, ref, dir), head, dir), paths).pass;

  // No batch branch below: the product file of the unmerged lower batch counts, as today.
  assert.equal(judged(main, "batch/guard-1"), false);
  run("update-ref", "refs/remotes/origin/batch/mixed-1", lower);
  run("update-ref", "refs/remotes/origin/batch/guard-1", upper);
  assert.equal(comparisonBase(main, upper, "batch/guard-1", dir), lower);
  assert.equal(judged(main, "batch/guard-1"), true);
  // Only batch branches are judged from below; any other pull request still compares with main.
  assert.equal(judged(main, "chore/guardrails"), false);
  // Main's own changes merged into the upper batch are not the batch's files.
  run("checkout", "-q", "-b", "next", main);
  const moved = commit("src/site/content.ts");
  run("checkout", "-q", "--detach", upper);
  run("merge", "-q", "--no-edit", moved);
  const remerged = run("rev-parse", "HEAD");
  assert.equal(judged(moved, "batch/guard-1", remerged), true);
  // Once the lower batch is on main it is no longer below, and main is the comparison again.
  run("checkout", "-q", "-b", "after", lower);
  const merged = commit("docs/pools.md");
  assert.equal(comparisonBase(merged, upper, "batch/guard-1", dir), merged);
  assert.equal(judged(merged, "batch/guard-1"), true);
});
