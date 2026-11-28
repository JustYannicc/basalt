import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { comparisonBase, gitIn, type CheckEvent, type Git } from "./ci/comparison-base.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const resolver = fileURLToPath(new URL("./ci/comparison-base.ts", import.meta.url));
// The jobs that compare a candidate with a commit; fast-units' one step runs in both legs.
const comparing = ["select", "fast", "fast-units", "cpa-pipeline"];
type Step = {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
const stepsOf = (job: string): Step[] => workflow.jobs[job].steps;
const comparison = (job: string) => stepsOf(job).find((step) => step.id === "comparison")!;

// 2026-01-05T00:00:00Z: fixtures date every commit and push exactly, in whole seconds from it.
const day = 1767571200;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const dated = (cwd: string, seconds: number, ...args: string[]) => {
  const date = `@${seconds} +0000`;
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(cwd, "rev-parse", "HEAD");
};
const commit = (cwd: string, message: string, seconds: number) =>
  dated(cwd, seconds, "commit", "-q", "--allow-empty", "-m", message);
const merge = (cwd: string, branch: string, seconds: number) =>
  dated(cwd, seconds, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch);

function fixture(run: (root: string, origin: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "basalt-comparison-"));
  const origin = join(root, "origin");
  try {
    mkdirSync(origin);
    git(origin, "init", "-q", "--initial-branch=main");
    git(origin, "config", "user.name", "CI fixture");
    git(origin, "config", "user.email", "ci@example.invalid");
    run(root, origin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
// A job's checkout as actions/checkout leaves it with fetch-depth 0 (or `flags`): every branch of
// the origin as it is now, the event's commit checked out, and the resolver beside it.
function checkout(root: string, name: string, origin: string, sha: string, ...flags: string[]) {
  const dir = join(root, name);
  git(root, "clone", "-q", "--no-local", ...flags, origin, dir);
  git(dir, "checkout", "-q", "--detach", sha);
  mkdirSync(join(dir, "scripts/ci"), { recursive: true });
  copyFileSync(resolver, join(dir, "scripts/ci/comparison-base.ts"));
  return dir;
}
// One job's comparison step as CI runs it, with GitHub's own variables for the event.
function resolve(dir: string, job: string, event: CheckEvent) {
  const output = `${dir}.output`;
  writeFileSync(`${dir}.event.json`, JSON.stringify(event.payload));
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", comparison(job).run!], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event.name,
      GITHUB_REF: event.ref,
      GITHUB_SHA: event.sha,
      GITHUB_EVENT_PATH: `${dir}.event.json`,
      GITHUB_OUTPUT: output,
    },
  });
  return { status: result.status, output: readFileSync(output, "utf8"), stderr: result.stderr };
}
const resolved = (run: ReturnType<typeof resolve>) => {
  assert.equal(run.status, 0, run.stderr);
  return /^base_sha=([0-9a-f]{40})\n$/.exec(run.output)?.[1] ?? assert.fail(run.output);
};
const refused = (run: ReturnType<typeof resolve>, why: RegExp) => {
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^::error::No comparison commit: /m);
  assert.match(run.stderr, why);
  assert.equal(run.output, "");
};
const batchPush = (sha: string, pushedAt: unknown, ref = "refs/heads/batch/b"): CheckEvent => ({
  name: "push",
  ref,
  sha,
  payload: { ref, before: "0".repeat(40), after: sha, repository: { pushed_at: pushedAt } },
});
// `sha` is GitHub's test merge of the head into the base branch, which the job checks out.
const pullRequest = (head: string, base: string, sha: string): CheckEvent => ({
  name: "pull_request",
  ref: "refs/pull/1/merge",
  sha,
  payload: { pull_request: { head: { sha: head }, base: { sha: base } } },
});
// GitHub's test merge as it makes one: the base side first, the head second, on a ref the
// job's checkout fetches.
const testMerge = (cwd: string, base: string, branch: string, seconds: number) => {
  git(cwd, "switch", "-q", "--detach", base);
  const sha = merge(cwd, branch, seconds);
  git(cwd, "branch", "-f", "pull-1-merge", sha);
  git(cwd, "switch", "-q", "main");
  return sha;
};

test("every comparing job resolves the commit with the one resolver, from the event alone", () => {
  for (const job of comparing) {
    const { if: condition, ...step } = comparison(job);
    // select skips it only on a reused Check, which compares nothing.
    assert.equal(condition, job === "select" ? "steps.reuse.outputs.reused != 'true'" : undefined);
    assert.deepEqual(
      step,
      {
        name: "Resolve the comparison commit",
        id: "comparison",
        run: "node scripts/ci/comparison-base.ts",
      },
      job,
    );
    const before = stepsOf(job).slice(0, stepsOf(job).indexOf(comparison(job)));
    const checkout = before.find((entry) => entry.uses === "actions/checkout@v4");
    assert.equal(checkout?.with?.["fetch-depth"], 0, job);
    assert.ok(
      before.some((entry) => entry.uses === "./.github/actions/setup-node"),
      job,
    );
    // No attempt-dependent step: a re-run resolves the same commit by the same rule.
    assert.doesNotMatch(JSON.stringify(stepsOf(job)), /run_attempt|download-artifact/, job);
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs[job]),
      /needs\.select\.outputs\.base_sha/,
      job,
    );
  }
  for (const job of ["fast", "fast-units"]) assert.equal(workflow.jobs[job].needs, undefined, job);
  // Nothing else in the Check resolves a comparison of its own.
  const text = JSON.stringify(workflow.jobs);
  assert.doesNotMatch(text, /merge-base|pushed_at/);
  assert.equal(text.split("node scripts/ci/comparison-base.ts").length - 1, comparing.length);
  const guard = stepsOf("cpa-pipeline").find((step) => step.run?.includes("cpa-pipeline-guard.py"));
  assert.equal(guard?.env?.BASE_SHA, "${{ steps.comparison.outputs.base_sha }}");
  assert.deepEqual(workflow.jobs["cpa-pipeline"].outputs, {
    base_sha: "${{ steps.comparison.outputs.base_sha }}",
  });
});

test("every job and re-run of a batch push compares with main as of the push, however main moves", () =>
  fixture((root, origin) => {
    commit(origin, "m0", day);
    const m1 = commit(origin, "m1", day + 100);
    git(origin, "switch", "-qc", "batch/a");
    const a1 = commit(origin, "a1", day + 150);
    git(origin, "switch", "-qc", "batch/b");
    const b1 = commit(origin, "b1", day + 200);
    git(origin, "switch", "-q", "main");
    // batch/b, stacked on batch/a, is pushed at day + 300.
    const pushed = batchPush(b1, day + 300);
    const early = checkout(root, "early", origin, b1);
    const first = ["select", "fast"].map((job) => resolved(resolve(early, job, pushed)));
    // batch/a merges before the other jobs fetch, moving the head's merge-base with main's tip.
    merge(origin, "batch/a", day + 400);
    const late = checkout(root, "late", origin, b1);
    assert.equal(git(late, "merge-base", b1, "refs/remotes/origin/main"), a1);
    const second = ["fast-units", "fast-units", "cpa-pipeline"].map((job) =>
      resolved(resolve(late, job, pushed)),
    );
    // A re-run hours later, with main another merge on, in the checkout that fetched first.
    git(origin, "switch", "-qc", "batch/c", m1);
    commit(origin, "c1", day + 4000);
    git(origin, "switch", "-q", "main");
    merge(origin, "batch/c", day + 5000);
    const rerun = comparing.map((job) => resolved(resolve(early, job, pushed)));
    assert.deepEqual([...first, ...second, ...rerun], Array(9).fill(m1));
  }));

test("main as of the push takes a merge dated the push's own second, and none after it", () =>
  fixture((root, origin) => {
    const m1 = commit(origin, "m1", day + 100);
    git(origin, "switch", "-qc", "batch/a");
    const a1 = commit(origin, "a1", day + 150);
    git(origin, "switch", "-qc", "batch/b");
    const b1 = commit(origin, "b1", day + 200);
    git(origin, "switch", "-q", "main");
    merge(origin, "batch/a", day + 400);
    const job = checkout(root, "job", origin, b1);
    // git's --before=<T> keeps a commit dated exactly T.
    for (const [seconds, expected] of [
      [day + 399, m1],
      [day + 400, a1],
      [day + 401, a1],
      [String(day + 400), a1],
    ] as const)
      assert.equal(resolved(resolve(job, "fast", batchPush(b1, seconds))), expected, `${seconds}`);
  }));

test("a batch push without its time or main's history up to it fails, never on main's tip", () =>
  fixture((root, origin) => {
    for (const [index, seconds] of [day, day + 100, day + 200, day + 300].entries())
      commit(origin, `m${index}`, seconds);
    git(origin, "switch", "-qc", "batch/b");
    const b1 = commit(origin, "b1", day + 350);
    git(origin, "switch", "-q", "main");
    const job = checkout(root, "job", origin, b1);
    const missing = batchPush(b1, undefined);
    refused(resolve(job, "select", missing), /has no repository\.pushed_at/);
    refused(
      resolve(job, "select", { ...missing, payload: { ref: missing.ref, after: b1 } }),
      /has no repository\.pushed_at/,
    );
    // What other events carry there, or anything but whole seconds.
    for (const seconds of [
      "2026-01-05T00:05:00Z",
      `${day + 250}.5`,
      day + 250.5,
      -1,
      "",
      null,
      true,
      ` ${day + 250}`,
      `+${day + 250}`,
      "0x10",
    ])
      refused(resolve(job, "select", batchPush(b1, seconds)), /not whole Unix seconds/);
    refused(resolve(job, "fast", batchPush(b1, day - 1)), /main has no first-parent commit dated/);
    // Two commits deep: main as of day + 250 is there, its parent and the date check's end aren't.
    const shallow = checkout(
      root,
      "shallow",
      `file://${origin}`,
      b1,
      "--depth=2",
      "--no-single-branch",
    );
    refused(resolve(shallow, "fast-units", batchPush(b1, day + 250)), /the checkout is shallow/);
    assert.equal(
      resolved(resolve(job, "fast-units", batchPush(b1, day + 250))),
      git(origin, "rev-parse", "main~1"),
    );
    // A commit off main, as a broken lookup could return, is refused rather than compared with.
    const real = gitIn(job);
    const offMain: Git = (...args) =>
      args[0] === "rev-list" && args[1] === "-1" ? b1 : real(...args);
    assert.throws(
      () => comparisonBase(batchPush(b1, day + 250), offMain),
      /main as of .*, [0-9a-f]{40}, is not an ancestor of origin\/main/,
    );
  }));

test("main's first-parent dates going back fail a batch push's comparison", () => {
  // From the root: a later commit dated before its parent, below or above main as of the push.
  for (const dates of [
    [day, day + 300, day + 200, day + 400],
    [day, day + 200, day + 500, day + 400],
  ])
    fixture((root, origin) => {
      for (const [index, seconds] of dates.entries()) commit(origin, `m${index}`, seconds);
      git(origin, "switch", "-qc", "batch/b", "main~3");
      const b1 = commit(origin, "b1", day + 50);
      const job = checkout(root, "job", origin, b1);
      refused(
        resolve(job, "cpa-pipeline", batchPush(b1, day + 250)),
        /main's commit dates go back: [0-9a-f]{40} \(.*\) is later than its first-parent child/,
      );
    });
});

// A stacked pull request: its head carries a1 from batch/a, which merges into main after the event.
function stackedPullRequest(origin: string) {
  commit(origin, "p0", day);
  const p1 = commit(origin, "p1", day + 100);
  git(origin, "switch", "-qc", "batch/a");
  const a1 = commit(origin, "a1", day + 150);
  git(origin, "switch", "-qc", "stacked");
  const head = commit(origin, "h1", day + 200);
  git(origin, "switch", "-q", "main");
  const p2 = commit(origin, "p2", day + 250);
  return { p1, a1, head, p2, merged: testMerge(origin, p2, "stacked", day + 260) };
}

test("every job and re-run of a pull request compares with the base side of the event's merge commit", () =>
  fixture((root, origin) => {
    const { p1, a1, head, p2, merged } = stackedPullRequest(origin);
    const event = pullRequest(head, p2, merged);
    const early = checkout(root, "early", origin, merged);
    const first = resolved(resolve(early, "select", event));
    // batch/a merges, then main moves on: later jobs and re-runs fetch that main.
    const tip = merge(origin, "batch/a", day + 400);
    commit(origin, "p3", day + 500);
    const late = checkout(root, "late", origin, merged);
    assert.equal(git(late, "merge-base", head, "refs/remotes/origin/main"), a1);
    const later = ["fast", "fast-units", "cpa-pipeline"].map((job) =>
      resolved(resolve(late, job, event)),
    );
    assert.deepEqual([first, ...later], [p1, p1, p1, p1]);
    // The payload's base commit is not what the job tested: a base.sha naming a later main than the
    // merge commit's base side changes nothing (with a fallback to it, this reads a1).
    assert.equal(git(late, "merge-base", head, tip), a1);
    const laterBase = {
      ...event,
      payload: { pull_request: { head: { sha: head }, base: { sha: tip } } },
    };
    assert.equal(resolved(resolve(late, "fast", laterBase)), p1);
    const noBase = { ...event, payload: { pull_request: { head: { sha: head } } } };
    assert.equal(resolved(resolve(late, "fast", noBase)), p1);
    refused(
      resolve(late, "fast", { ...event, payload: { pull_request: { base: { sha: p2 } } } }),
      /the event carries no commit at pull_request\.head\.sha/,
    );
  }));

test("a pull request whose merge commit isn't in the checkout fails, never on its base commit", () =>
  fixture((root, origin) => {
    const { head, p2, merged } = stackedPullRequest(origin);
    const narrow = checkout(root, "narrow", origin, head, "--single-branch", "--branch=stacked");
    assert.throws(() => git(narrow, "cat-file", "-e", `${merged}^{commit}`));
    refused(
      resolve(narrow, "fast", pullRequest(head, p2, merged)),
      new RegExp(`the event's merge commit ${merged} is not in the checkout`),
    );
    refused(resolve(narrow, "fast", pullRequest(head, p2, "")), /the event names no merge commit/);
  }));

test("a pull request whose commit is not a two-parent merge fails, never on its base commit", () =>
  fixture((root, origin) => {
    const { head, p2, merged } = stackedPullRequest(origin);
    const job = checkout(root, "job", origin, merged);
    refused(
      resolve(job, "fast", pullRequest(head, p2, head)),
      new RegExp(
        `the event's merge commit ${head} has 1 parent\\(s\\), not the base side and the head`,
      ),
    );
    git(origin, "switch", "-qc", "third", p2);
    commit(origin, "t1", day + 270);
    git(origin, "switch", "-q", "--detach", p2);
    const octopus = dated(
      origin,
      day + 280,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "octopus",
      "stacked",
      "third",
    );
    git(origin, "branch", "octopus", octopus);
    const wide = checkout(root, "wide", origin, octopus);
    refused(
      resolve(wide, "fast", pullRequest(head, p2, octopus)),
      /has 3 parent\(s\), not the base side and the head/,
    );
  }));

test("a pull request whose merge commit merges another head fails, never on its base commit", () =>
  fixture((root, origin) => {
    const { a1, head, p2, merged } = stackedPullRequest(origin);
    const job = checkout(root, "job", origin, merged);
    refused(
      resolve(job, "fast", pullRequest(a1, p2, merged)),
      new RegExp(
        `the event's merge commit ${merged} merges ${head}, not the pull request's head ${a1}`,
      ),
    );
  }));

test("the pipeline guard excludes a merged release bump from an older PR's merged checkout", () =>
  // The origin doubles as the job's checkout, with itself as its remote.
  fixture((_, root) => {
    const guard = stepsOf("cpa-pipeline").find((entry) =>
      entry.run?.includes("cpa-pipeline-guard.py"),
    )!;
    const sources = join(root, "containers/pool/sources.json");
    const pin = (commit: string) =>
      writeFileSync(
        sources,
        JSON.stringify({
          artifacts: { node: { repository: "fixture/node", commit, patches: [] } },
        }),
      );
    mkdirSync(join(root, "containers/pool/patches"), { recursive: true });
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    copyFileSync(
      new URL("./cpa-pipeline-guard.py", import.meta.url),
      join(root, "scripts/cpa-pipeline-guard.py"),
    );
    pin("old-release");
    writeFileSync(join(root, "client"), "original client");
    git(root, "add", "containers", "client", "scripts/cpa-pipeline-guard.py");
    git(root, "commit", "-qm", "old release");
    const stale = git(root, "rev-parse", "HEAD");
    git(root, "branch", "pr");
    pin("merged-release");
    writeFileSync(
      join(root, "containers/pool/patches/home-compatibility.patch"),
      "merged Home carry",
    );
    git(root, "add", "containers");
    git(root, "commit", "-qm", "release bump and Home compatibility");
    const current = git(root, "rev-parse", "HEAD");
    git(root, "remote", "add", "origin", root);
    git(root, "switch", "-q", "pr");
    writeFileSync(join(root, "client"), "new client");
    git(root, "commit", "-qam", "client change");
    const head = git(root, "rev-parse", "HEAD");
    // GitHub's test merge of the PR into main after the bump: main's side first, the head second.
    git(root, "switch", "-q", "--detach", "main");
    git(root, "merge", "--no-ff", "-m", "PR merge ref", "pr");
    const merged = git(root, "rev-parse", "HEAD");
    assert.equal(git(root, "merge-base", "HEAD", "main"), current);
    copyFileSync(resolver, join(root, "scripts/ci/comparison-base.ts"));
    // Whatever base commit the event names, the merge-base is the head's with the merge's main side.
    const [base, fresher] = [stale, current].map((target) =>
      resolved(resolve(root, "cpa-pipeline", pullRequest(head, target, merged))),
    );
    assert.equal(base, stale);
    assert.equal(fresher, stale);
    const command = guard
      .run!.split("\n")
      .filter((line) => !line.trimStart().startsWith("python3 -m unittest "))
      .join("\n");
    const check = (candidate = head) =>
      spawnSync("bash", ["-e", "-c", command], {
        cwd: root,
        env: { ...process.env, BASE_SHA: base, HEAD_SHA: candidate, BATCH_MODE: "false" },
        encoding: "utf8",
      });
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "CPA source pin unchanged");
    git(root, "switch", "-q", "--detach", head);
    pin("new-bump-in-this-PR");
    writeFileSync(join(root, "containers/pool/runtime.py"), "unrelated runtime change");
    git(root, "add", "containers");
    git(root, "commit", "-qm", "negative bump on source head");
    const combined = check(git(root, "rev-parse", "HEAD"));
    assert.notEqual(combined.status, 0);
    assert.match(combined.stderr, /CPA bump changes runtime code: containers\/pool\/runtime.py/);
  }));
