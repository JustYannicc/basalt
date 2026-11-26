import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { onlyOnRerun, rerunOnly } from "./ci/fast-plan.ts";
import { laneBase, startJobErrors } from "./ci/gate.ts";
import { recordedBase, recordedSelectionPath, selectCarried } from "./ci/rerun-selection.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const script = (name: string) => fileURLToPath(new URL(`./ci/${name}`, import.meta.url));
const comparison = (job: string) =>
  workflow.jobs[job].steps.find((step: { id?: string }) => step.id === "comparison");
type Job = { name: string; run_attempt: number; created_at: string; started_at: string | null };
// An attempt's job list as GitHub pages it, fifty a page. Every job of the attempt is listed with
// its number and a new id; a carried one keeps the times it ran at in an earlier attempt.
const listing =
  (attempt: number, jobs: Job[]) =>
  async (path: string): Promise<unknown> => {
    const match = new RegExp(
      `^/actions/runs/7/attempts/${attempt}/jobs\\?per_page=50&page=(\\d+)$`,
    ).exec(path);
    assert.ok(match, path);
    const page = Number(match[1]);
    return { jobs: jobs.slice((page - 1) * 50, page * 50) };
  };
const job = (name: string, run_attempt: number, created: string, started: string | null) => ({
  name,
  run_attempt,
  created_at: `2026-01-05T${created}Z`,
  started_at: started && `2026-01-05T${started}Z`,
});
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
  const rerun = { id: "7", attempt: 2 };
  const fullRerun = { ...rerun, attempt: 3 };
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

    // 1. Attempt 1: select (created 09:00:10, started 09:05:02) and both legs resolve X; leg 2
    // then fails on a flaky test.
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

    // 3. "Re-run failed jobs", attempt 2: the carried select is listed as attempt 2's, created
    // with the attempt but started at attempt 1's time; the re-run leg takes its recorded X.
    const failedJobs = listing(2, [
      job("select", 2, "10:30:30", "09:05:02"),
      job("fast-units (2)", 2, "10:30:30", "10:31:00"),
    ]);
    const carried = await selectCarried(rerun, failedJobs);
    assert.equal(carried.carried, true, carried.note);
    const { base, note } = recordedBase(temp, false);
    assert.equal(base, x, note);
    assert.equal(resolve("fast-units", base), x);
    const leg = lane(x);
    assert.deepEqual(startJobErrors("full", x, selected, legs(selected, leg)), []);

    // 4. The same re-run resolving afresh, as before this fix, compares with Y and fails the gate.
    const afresh = lane(resolve("fast-units"));
    assert.equal(afresh, laneBase("full", y));
    assert.deepEqual(startJobErrors("full", x, selected, legs(selected, afresh)), [
      `fast-units leg 2: resolved ${JSON.stringify(afresh)}, select ${JSON.stringify(selected)}`,
    ]);

    // 5. Without select's record the leg resolves afresh and warns; the aggregate still fails it
    // once main moved, as step 4 shows, and passes it while main hasn't.
    writeFileSync(recordedSelectionPath(temp), JSON.stringify({ lane: "full" }));
    const unrecorded = recordedBase(temp, false);
    assert.equal(unrecorded.base, "");
    assert.match(unrecorded.note, /^::warning::.*records no comparison commit.*Re-run all jobs/);
    rmSync(recordedSelectionPath(temp));
    const absent = recordedBase(temp, false);
    assert.equal(absent.base, "");
    assert.match(absent.note, /^::warning::.*has no ci-selection artifact/);
    // A reused Check records nothing, and a main push's comparison never moves: no warning.
    const main = recordedBase(temp, true);
    assert.equal(main.base, "");
    assert.doesNotMatch(main.note, /::warning::/);

    // 6. "Re-run all jobs", attempt 3: select runs again (started after it was created, here on
    // the listing's second page) and resolves Y afresh; so do fast and both legs.
    const fullJobs = [
      ...Array.from({ length: 50 }, (_, index) => job(`job ${index}`, 3, "10:50:29", null)),
      job("select", 3, "10:50:29", "10:51:13"),
    ];
    const again = await selectCarried(fullRerun, listing(3, fullJobs));
    assert.equal(again.carried, false, again.note);
    assert.match(again.note, /^select runs again in attempt 3/);
    assert.equal(resolve("select"), y);
    record(y);
    const fresh = [resolve("fast"), resolve("fast-units"), resolve("fast-units")].map(lane);
    assert.deepEqual(
      fresh,
      [y, y, y].map((base) => laneBase("full", base)),
    );
    assert.deepEqual(startJobErrors("full", y, fresh[0], legs(fresh[1]!, fresh[2]!)), []);
    // A select still queued, or started the second GitHub created it, runs in this attempt: GitHub
    // reports a queued job's creation as its start.
    const queued = listing(3, [job("select", 3, "10:50:29", "10:50:29")]);
    assert.equal((await selectCarried(fullRerun, queued)).carried, false);

    // Whatever can't tell the two apart keeps today's afresh resolution, and says so: an
    // unreadable listing, one without select, or a select listed without a start.
    const failed = await selectCarried(rerun, async () => {
      throw new Error("GitHub returned 502");
    });
    assert.equal(failed.carried, false);
    assert.match(failed.note, /^::warning::.*502/);
    const missing = await selectCarried(
      rerun,
      listing(2, [job("fast", 2, "10:30:30", "10:31:00")]),
    );
    assert.equal(missing.carried, false);
    assert.match(missing.note, /^::warning::.*no select job/);
    const unstarted = await selectCarried(
      fullRerun,
      listing(3, [job("select", 3, "10:50:29", null)]),
    );
    assert.equal(unstarted.carried, false);
    assert.match(unstarted.note, /^::warning::Attempt 3 lists select without a start/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a re-run attempt reads select's record, in both start jobs", () => {
  const download = (step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@");
  const carriedOnly = `${rerunOnly} && steps.carried.outputs.carried == 'true'`;
  for (const job of ["fast", "fast-units"]) {
    const { steps, permissions } = workflow.jobs[job];
    const at = (id: string) => steps.findIndex((step: { id?: string }) => step.id === id);
    const reruns = steps.filter((step: { if?: string }) => onlyOnRerun(step.if));
    assert.deepEqual(
      reruns.map((step: { uses?: string; run?: string }) => step.uses ?? step.run),
      [
        "node scripts/ci/rerun-selection.ts",
        "actions/download-artifact@v4",
        "node scripts/ci/rerun-selection.ts base",
      ],
      job,
    );
    // Every download and every attempt-dependent step is one of these three.
    assert.deepEqual(steps.filter(download), reruns.slice(1, 2), job);
    assert.deepEqual(
      steps.filter((step: object) => JSON.stringify(step).includes("run_attempt")),
      reruns,
      job,
    );
    const [decide, fetch, take] = reruns;
    assert.equal(decide.id, "carried", job);
    assert.equal(decide.if, rerunOnly, job);
    assert.deepEqual(decide.env, { GITHUB_TOKEN: "${{ github.token }}" }, job);
    // Only a carried select left a record to download, so no other re-run reports one missing.
    assert.equal(fetch.if, carriedOnly, job);
    assert.equal(take.if, carriedOnly, job);
    assert.deepEqual(fetch.with, { name: "ci-selection", path: "${{ runner.temp }}/ci-selection" });
    assert.equal(dirname(recordedSelectionPath("${{ runner.temp }}")), fetch.with.path);
    // A missing record is rerun-selection's to judge, so the download never fails the job.
    assert.equal(fetch["continue-on-error"], true, job);
    assert.equal(take.id, "rerun", job);
    assert.equal(take.env, undefined, job);
    assert.ok(
      steps.indexOf(decide) < steps.indexOf(fetch) &&
        steps.indexOf(fetch) < steps.indexOf(take) &&
        at("comparison") > steps.indexOf(take),
      job,
    );
    assert.equal(comparison(job).env.RECORDED_BASE, "${{ steps.rerun.outputs.base_sha }}", job);
    assert.deepEqual(permissions, { actions: "read", contents: "read" }, job);
  }
  // select resolves afresh in its every attempt and records what it resolved.
  const select = workflow.jobs.select.steps;
  assert.equal(
    select.some((step: { if?: string }) => onlyOnRerun(step.if)),
    false,
  );
  const upload = select.find(
    (step: { with?: { name?: string } }) => step.with?.name === "ci-selection",
  );
  assert.equal(upload.uses, "actions/upload-artifact@v4");
  assert.equal(upload.with.path, ".generated/ci/selection.json");
});
