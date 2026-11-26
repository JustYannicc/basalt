import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rerunOnly } from "./ci/fast-plan.ts";
import { laneBase, startJobErrors } from "./ci/gate.ts";
import { recordedSelectionPath, rerunBase } from "./ci/rerun-selection.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const script = (name: string) => fileURLToPath(new URL(`./ci/${name}`, import.meta.url));
const comparison = (job: string) =>
  workflow.jobs[job].steps.find((step: { id?: string }) => step.id === "comparison");
type Job = { name: string; run_attempt: number };
// The attempt's job list as GitHub pages it: fifty a page.
const listing =
  (jobs: Job[]) =>
  async (path: string): Promise<unknown> => {
    const match = /^\/actions\/runs\/7\/attempts\/2\/jobs\?per_page=50&page=(\d+)$/.exec(path);
    assert.ok(match, path);
    const page = Number(match[1]);
    return { jobs: jobs.slice((page - 1) * 50, page * 50) };
  };
const legs = (...values: string[]) =>
  Object.fromEntries(values.map((value, index) => [`leg_${index + 1}`, value]));

test("a re-run leg compares with select's recorded commit unless select runs again", async () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-rerun-base-"));
  const temp = join(root, "runner");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  // One step's GITHUB_OUTPUT value.
  const output = (key: string, run: () => void) => {
    const file = join(temp, "output");
    writeFileSync(file, "");
    run();
    const value = new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(file, "utf8"))?.[1];
    return value ?? assert.fail(`no ${key}`);
  };
  // A full Check of a batch push; its comparison fetches main and takes the merge-base.
  const event = {
    ...process.env,
    PULL_REQUEST: "false",
    BATCH_PUSH: "true",
    BASE_REF: "main",
    BASE_SHA: "f".repeat(40),
    FULL_SUITE: "true",
    AFFECTED_LANE: "false",
    GITHUB_OUTPUT: join(temp, "output"),
    GITHUB_STEP_SUMMARY: "",
    BOX_SLOTS: "",
  };
  const resolve = (job: string, recorded = "") =>
    output("base_sha", () =>
      execFileSync("bash", ["-e", "-c", comparison(job).run], {
        cwd: root,
        env: { ...event, HEAD_SHA: head, RECORDED_BASE: recorded },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  const lane = (base: string) =>
    output("lane_base", () =>
      execFileSync(process.execPath, [script("lane.ts")], {
        cwd: root,
        env: { ...event, BASE_SHA: base, HEAD_SHA: head },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  // select's record, as its upload stores it and a start job's download restores it.
  const record = (base: string) => {
    execFileSync(process.execPath, [script("select-jobs.ts"), "--all"], {
      cwd: root,
      env: { ...event, BASE_SHA: base, HEAD_SHA: head },
      stdio: ["ignore", "pipe", "pipe"],
    });
    mkdirSync(dirname(recordedSelectionPath(temp)), { recursive: true });
    copyFileSync(join(root, ".generated/ci/selection.json"), recordedSelectionPath(temp));
  };
  const rerun = { id: "7", attempt: 2, temp, event: "push", ref: "refs/heads/batch/one" };
  let head = "";
  try {
    mkdirSync(temp);
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    writeFileSync(join(root, "input"), "base");
    git("add", "input");
    git("commit", "-qm", "base");
    const x = git("rev-parse", "HEAD");
    git("remote", "add", "origin", root);
    git("switch", "-qc", "batch/one");
    writeFileSync(join(root, "input"), "batch");
    git("commit", "-qam", "batch");
    head = git("rev-parse", "HEAD");

    // 1. Attempt 1: select and both legs resolve X; leg 2 then fails on a flaky test.
    assert.equal(resolve("select"), x);
    record(x);
    assert.equal(resolve("fast-units"), x);
    assert.equal(lane(x), laneBase("full", x));
    const selected = laneBase("full", x);
    assert.deepEqual(startJobErrors("full", x, selected, legs(selected, selected)), []);

    // 2. Main merges twice, the batch among them: its merge-base with main is now Y.
    git("switch", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge the batch", "batch/one");
    writeFileSync(join(root, "later"), "another merge");
    git("add", "later");
    git("commit", "-qm", "another merge");
    git("switch", "-q", "batch/one");
    const y = git("merge-base", head, "main");
    assert.notEqual(y, x);

    // 3. "Re-run failed jobs": select carries over, listed with its own attempt or not at all.
    for (const jobs of [
      [
        { name: "select", run_attempt: 1 },
        { name: "fast-units (2)", run_attempt: 2 },
      ],
      [{ name: "fast-units (2)", run_attempt: 2 }],
    ]) {
      const { base, note } = await rerunBase(rerun, listing(jobs));
      assert.equal(base, x, note);
      assert.equal(resolve("fast-units", base), x);
    }
    const leg = lane(x);
    assert.deepEqual(startJobErrors("full", x, selected, legs(selected, leg)), []);

    // 4. The same re-run resolving afresh, as before this fix, compares with Y and fails the gate.
    const afresh = lane(resolve("fast-units"));
    assert.equal(afresh, laneBase("full", y));
    assert.deepEqual(startJobErrors("full", x, selected, legs(selected, afresh)), [
      `fast-units leg 2: resolved ${JSON.stringify(afresh)}, select ${JSON.stringify(selected)}`,
    ]);

    // 5. Without select's record a carried select fails closed rather than resolve afresh.
    const carried = listing([{ name: "fast-units (2)", run_attempt: 2 }]);
    writeFileSync(recordedSelectionPath(temp), JSON.stringify({ lane: "full" }));
    await assert.rejects(rerunBase(rerun, carried), /records no comparison commit/);
    rmSync(recordedSelectionPath(temp));
    await assert.rejects(rerunBase(rerun, carried), /has no ci-selection artifact/);
    // A reused Check records nothing, and a main push's comparison never moves.
    const main = { ...rerun, ref: "refs/heads/main" };
    assert.equal((await rerunBase(main, carried)).base, "");

    // 6. "Re-run all jobs": select runs again, on a later page too, and resolves Y; so do the legs.
    const full = [
      ...Array.from({ length: 50 }, (_, index) => ({ name: `job ${index}`, run_attempt: 2 })),
      { name: "select", run_attempt: 2 },
    ];
    const again = await rerunBase(rerun, listing(full));
    assert.equal(again.base, "", again.note);
    assert.equal(resolve("select"), y);
    record(y);
    const fresh = [resolve("fast"), resolve("fast-units", again.base), resolve("fast-units")].map(
      lane,
    );
    assert.deepEqual(startJobErrors("full", y, fresh[0], legs(fresh[1]!, fresh[2]!)), []);

    // An unreadable listing keeps today's afresh resolution, and says so.
    const failed = await rerunBase(rerun, async () => {
      throw new Error("GitHub returned 502");
    });
    assert.equal(failed.base, "");
    assert.match(failed.note, /^::warning::.*502/);
    const other = await rerunBase(rerun, listing([{ name: "select", run_attempt: 1 }]));
    assert.equal(other.base, "");
    assert.match(other.note, /^::warning::GitHub listed none of attempt 2's jobs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a re-run attempt reads select's record, in both start jobs", () => {
  const download = (step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@");
  for (const job of ["fast", "fast-units"]) {
    const { steps, permissions } = workflow.jobs[job];
    const at = (id: string) => steps.findIndex((step: { id?: string }) => step.id === id);
    const reruns = steps.filter((step: { if?: string }) => step.if === rerunOnly);
    assert.deepEqual(
      reruns.map((step: { uses?: string; run?: string }) => step.uses ?? step.run),
      ["actions/download-artifact@v4", "node scripts/ci/rerun-selection.ts"],
      job,
    );
    // Every download and every attempt-dependent step is one of these two.
    assert.deepEqual(steps.filter(download), reruns.slice(0, 1), job);
    assert.deepEqual(
      steps.filter((step: object) => JSON.stringify(step).includes("run_attempt")),
      reruns,
      job,
    );
    const [fetch, decide] = reruns;
    assert.deepEqual(fetch.with, { name: "ci-selection", path: "${{ runner.temp }}/ci-selection" });
    assert.equal(dirname(recordedSelectionPath("${{ runner.temp }}")), fetch.with.path);
    // A missing record is rerun-selection's to judge, so the download never fails the job.
    assert.equal(fetch["continue-on-error"], true, job);
    assert.equal(decide.id, "rerun", job);
    assert.deepEqual(decide.env, { GITHUB_TOKEN: "${{ github.token }}" }, job);
    assert.ok(
      steps.indexOf(decide) > steps.indexOf(fetch) && at("comparison") > steps.indexOf(decide),
      job,
    );
    assert.equal(comparison(job).env.RECORDED_BASE, "${{ steps.rerun.outputs.base_sha }}", job);
    assert.deepEqual(permissions, { actions: "read", contents: "read" }, job);
  }
  // select resolves afresh in its every attempt, and a later one replaces its earlier record.
  const select = workflow.jobs.select.steps;
  assert.equal(
    select.some((step: { if?: string }) => step.if === rerunOnly),
    false,
  );
  const upload = select.find(
    (step: { with?: { name?: string } }) => step.with?.name === "ci-selection",
  );
  assert.equal(upload.uses, "actions/upload-artifact@v4");
  assert.equal(upload.with.path, ".generated/ci/selection.json");
  assert.equal(upload.with.overwrite, true);
});
