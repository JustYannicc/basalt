import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One git command in the checkout: its trimmed output, or a throw on a non-zero exit. */
export type Git = (...args: string[]) => string;
export const gitIn =
  (cwd: string): Git =>
  (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** What the comparison reads of a run: GitHub's event name, ref and sha, and the event payload. */
export type CheckEvent = { name: string; ref: string; sha: string; payload: unknown };

const main = "refs/remotes/origin/main";
const field = (value: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>(
      (at, key) =>
        at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined,
      value,
    );
const commitAt = (payload: unknown, path: string) => {
  const value = field(payload, path);
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    throw new Error(`the event carries no commit at ${path}`);
  return value;
};
const when = (seconds: string) => {
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? `@${seconds}` : date.toISOString();
};

/** A batch push's time in whole Unix seconds, as push payloads carry repository.pushed_at. */
function pushedAt(payload: unknown) {
  const value = field(payload, "repository.pushed_at");
  if (value === undefined)
    throw new Error(
      "the push event has no repository.pushed_at, so main as of the push is unknown",
    );
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  // Other events carry an ISO string here; only a push's integer is the push time.
  if (!/^[0-9]+$/.test(text))
    throw new Error(
      `the push event's repository.pushed_at is ${JSON.stringify(value)}, not whole Unix seconds, so main as of the push is unknown`,
    );
  return text;
}

/**
 * main as of `seconds`: its last first-parent commit dated then or earlier. Every job and re-run
 * of a push reads the same seconds and main's history up to them, which later merges don't
 * change. Anything that leaves that commit uncertain fails; it never falls back to main's tip.
 */
function mainAsOf(git: Git, seconds: string) {
  // A shallow checkout may stop above that commit or its parent, which the date check reads.
  if (git("rev-parse", "--is-shallow-repository") !== "false")
    throw new Error(
      "the checkout is shallow, so it may not reach main as of the push; check out with fetch-depth: 0",
    );
  // git's raw date form: a bare "@<seconds>" under nine digits reads as some other date.
  const commit = git("rev-list", "-1", "--first-parent", `--before=@${seconds} +0000`, main);
  if (!commit) throw new Error(`main has no first-parent commit dated ${when(seconds)} or earlier`);
  try {
    git("merge-base", "--is-ancestor", commit, main);
  } catch {
    throw new Error(`main as of ${when(seconds)}, ${commit}, is not an ancestor of origin/main`);
  }
  // The rule reads each commit's date as when it landed, so along main's first parents, from the
  // tip down to the commit's parent, a date must never be later than its child's.
  const walk = [
    ...git("rev-list", "--first-parent", "--timestamp", main, `^${commit}`).split("\n"),
    ...git("rev-list", "--first-parent", "--timestamp", "--max-count=2", commit).split("\n"),
  ]
    .filter(Boolean)
    .map((line) => line.split(" "));
  for (const [index, [time = "", parent = ""]] of walk.entries()) {
    const [childTime = time, child = parent] = walk[index - 1] ?? [];
    if (Number(time) > Number(childTime))
      throw new Error(
        `main's commit dates go back: ${parent} (${when(time)}) is later than its first-parent child ${child} (${when(childTime)}), so they can't say what main was at ${when(seconds)}`,
      );
  }
  return commit;
}

/**
 * The base side of a pull request event's merge commit: GitHub's test merge of the head into the
 * base branch as the event fired, which every job and re-run checks out. Anything else about that
 * commit fails; it never falls back to the event's base commit or to main's tip.
 */
function mergedInto(git: Git, merged: string, head: string) {
  if (!/^[0-9a-f]{40}$/.test(merged)) throw new Error("the event names no merge commit");
  try {
    git("cat-file", "-e", `${merged}^{commit}`);
  } catch {
    throw new Error(`the event's merge commit ${merged} is not in the checkout`);
  }
  const parents = git("rev-list", "--parents", "--max-count=1", merged).split(" ").slice(1);
  if (parents.length !== 2)
    throw new Error(
      `the event's merge commit ${merged} has ${parents.length} parent(s), not the base side and the head`,
    );
  const [target = "", second] = parents;
  if (second !== head)
    throw new Error(
      `the event's merge commit ${merged} merges ${second}, not the pull request's head ${head}`,
    );
  return target;
}

/**
 * The commit a Check compares its head with, by one rule over the event. Every job of a run reads
 * the same payload and commit, and so does every re-run, so they all resolve the same commit however
 * far main has moved since: a pull request's merge-base with the base side of the event's merge
 * commit, a batch push's merge-base with main as of the push, and a main push's previous commit
 * (with none, its merge-base with main).
 */
export function comparisonBase(event: CheckEvent, git: Git) {
  let found: string, note: string;
  if (event.name === "pull_request") {
    const head = commitAt(event.payload, "pull_request.head.sha");
    const target = mergedInto(git, event.sha, head);
    found = git("merge-base", head, target);
    note = `the merge-base of ${head} with ${target}, the base side of the event's merge commit ${event.sha}`;
  } else if (event.name === "push" && event.ref.startsWith("refs/heads/batch/")) {
    const seconds = pushedAt(event.payload);
    git("fetch", "--no-tags", "origin", `+refs/heads/main:${main}`);
    const at = mainAsOf(git, seconds);
    found = git("merge-base", event.sha, at);
    note = `the merge-base of ${event.sha} with main as of the push at ${when(seconds)}, ${at}`;
  } else if ((found = commitAt(event.payload, "before")) !== "0".repeat(40)) {
    note = "the push's previous commit";
  } else {
    git("fetch", "--no-tags", "origin", `+refs/heads/main:${main}`);
    found = git("merge-base", event.sha, main);
    note = `the merge-base of ${event.sha} with main, as the push has no previous commit`;
  }
  return { base: git("rev-parse", "--verify", `${found}^{commit}`), note };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  try {
    const { base, note } = comparisonBase(
      {
        name: env.GITHUB_EVENT_NAME ?? "",
        ref: env.GITHUB_REF ?? "",
        sha: env.GITHUB_SHA ?? "",
        payload: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8")),
      },
      gitIn(process.cwd()),
    );
    appendFileSync(env.GITHUB_OUTPUT ?? "", `base_sha=${base}\n`);
    console.log(`Comparison commit ${base}: ${note}.`);
  } catch (error) {
    console.error(
      `::error::No comparison commit: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
