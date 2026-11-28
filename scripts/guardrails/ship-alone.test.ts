import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sharedOf } from "./release-path.ts";
import { batchFiles, comparisonBase, laneLine, shipAlone } from "./ship-alone.ts";
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

test("a change to a module the fleet lane imports is named in one line, capped at twenty", () => {
  const lane = Array.from({ length: 22 }, (_, i) => `src/pool/lane-${i}.ts`);
  assert.equal(laneLine(["src/pool/worker.ts"], lane), undefined);
  assert.equal(
    laneLine(["src/pool/lane-3.ts", "src/pool/worker.ts"], lane),
    "Touches 1 module the fleet lane imports: src/pool/lane-3.ts.",
  );
  const all = laneLine(lane, lane)!;
  assert.match(all, /^Touches 22 modules the fleet lane imports: /u);
  assert.equal(all.split(", ").length, 21);
  assert.ok(all.endsWith(", …."), all);
});

test("a lane module that is not release path leaves the guard's verdict to the release path", () => {
  // Release-path plus a lane module: the lane module is other code, so the change is a mix.
  const paths = ["scripts/release/**"];
  assert.equal(shipAlone(["scripts/release/deploy.ts", "src/pool/lane-0.ts"], paths).pass, false);
  // A lane module alone is ordinary code: the guard passes and only names it.
  assert.equal(shipAlone(["src/pool/lane-0.ts"], paths).pass, true);
});

test("a carry on the deploy library ships alone with its tests, fixtures and record entry", () => {
  const carry = [
    "patches/0813-alchemy-container-readback-retry.patch",
    "patches/0813-alchemy-container-readback-retry.json",
    "architecture/model/carries/0813-alchemy-container-readback-retry.c4",
    "scripts/releases/dependency-carries.json",
    "scripts/upstream-tests/container-readback-after-create.test.ts",
    "scripts/upstream-tests/fixtures/container-readback-after-create.ts",
    "scripts/stage-cloudflare/test/cloudflare-shapes.d.mts",
  ];
  const paths = ["patches/*alchemy*"];
  assert.deepEqual(shipAlone(carry, paths), {
    pass: true,
    releasePath: carry.slice(0, 2),
    other: [],
  });
  // Product code with it is still a mix.
  assert.equal(shipAlone([...carry, "scripts/stage-cloudflare/api.mjs"], paths).pass, false);
});

test("a pull request cannot widen what travels with its own release-path files", () => {
  const main = ["architecture/**", "package.json"];
  const head = ["architecture/**", "package.json", "src/**"];
  const travel = sharedOf(main, main, head);
  assert.deepEqual(travel, ["architecture/**", "package.json"]);
  assert.equal(
    shipAlone(["scripts/release/deploy.ts", "src/pool/worker.ts"], ["scripts/release/**"], travel)
      .pass,
    false,
  );
  assert.equal(
    shipAlone(["scripts/release/deploy.ts", "src/pool/worker.ts"], ["scripts/release/**"], head)
      .pass,
    true,
  );
});
