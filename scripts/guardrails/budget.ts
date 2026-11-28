import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { onReleasePath, releasePaths, releasePathsAt, unionOfPaths } from "./release-path.ts";

// Release tooling grew by answering each failure with more machinery. The budget holds the
// release path's source and test lines; they may fall freely, but rise only with a reuse decision
// in the pull request and the release-budget-approved label. Tombstoned paths take no new lines.
export const approvalLabel = "release-budget-approved";
const budgetUrl = new URL("./budget.json", import.meta.url);
export const testFile = /(?:^|\/)(?:test|tests|fixtures|[\w-]+-tests)\/|\.test\.[cm]?[jt]s$/u;
const reuseDecision = /^## Reuse decision\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mu;

export type Budget = { lines: number; testLines: number; tombstones: string[] };
export type Count = { lines: number; testLines: number };
export type PullRequest = { body: string; labels: string[] };

export const tombstoned = (file: string, budget: Pick<Budget, "tombstones">) =>
  budget.tombstones.some((pattern) => matchesGlob(file, pattern));

export function budgetErrors(input: {
  count: Count;
  budget: Budget;
  base: Budget | null;
  droppedPaths: string[];
  addedToTombstones: { file: string; added: number }[];
  pullRequest: PullRequest | null;
}): string[] {
  const { count, budget, base } = input;
  const errors = input.addedToTombstones.map(
    ({ file, added }) => `${file} adds ${added} lines to a removed path; it takes no new lines.`,
  );
  for (const [key, label] of [
    ["lines", "source"],
    ["testLines", "test"],
  ] as const) {
    if (count[key] < budget[key])
      errors.push(
        `Release tooling ${label} shrank to ${count[key]} lines: lower "${key}" in budget.json to ${count[key]}.`,
      );
    if (count[key] > budget[key])
      errors.push(
        `Release tooling ${label} grew to ${count[key]} lines against a budget of ${budget[key]}. Raise "${key}" in budget.json with a reuse decision and the ${approvalLabel} label, or reuse what Cloudflare, Alchemy or a library already does.`,
      );
  }
  const reasons = [
    base && budget.lines > base.lines && `raises the source budget to ${budget.lines}`,
    base && budget.testLines > base.testLines && `raises the test budget to ${budget.testLines}`,
    base &&
      base.tombstones.some((path) => !budget.tombstones.includes(path)) &&
      "reopens a tombstoned path",
    input.droppedPaths.length > 0 && `drops ${input.droppedPaths.join(", ")} from the release path`,
  ].filter(Boolean);
  if (reasons.length) {
    const what = reasons.join(" and ");
    const decision = input.pullRequest?.body.match(reuseDecision)?.[1] ?? "";
    if (!/https?:\/\/\S+/u.test(decision))
      errors.push(
        `This ${what}: add a "## Reuse decision" section to the pull request naming the need, what Cloudflare, Alchemy and existing libraries provide (with links) and why that is not enough.`,
      );
    if (!input.pullRequest?.labels.includes(approvalLabel))
      errors.push(`This ${what}: it needs the ${approvalLabel} label.`);
  }
  return errors;
}

const git = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 << 20 }).trim();

// Tracked and new files alike, so a budget written before `git add` matches CI.
export function countLines(paths: readonly string[], budget: Pick<Budget, "tombstones">): Count {
  const count = { lines: 0, testLines: 0 };
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0");
  for (const file of new Set(files)) {
    if (!file || !onReleasePath(file, paths) || tombstoned(file, budget)) continue;
    const text = readFileSync(file, "utf8");
    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    count[testFile.test(file) ? "testLines" : "lines"] += lines;
  }
  return count;
}

function addedToTombstones(base: string, budget: Budget) {
  return git(["diff", "--numstat", "--no-renames", "-z", `${base}...HEAD`])
    .split("\0")
    .map((record) => record.split("\t"))
    .filter(([added, , file]) => file && Number(added) > 0 && tombstoned(file, budget))
    .map(([added, , file]) => ({ file: file!, added: Number(added) }));
}

function readBase(base: string): Budget | null {
  try {
    const text = execFileSync("git", ["show", `${base}:scripts/guardrails/budget.json`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(text);
  } catch (error) {
    // Only a budget that does not exist yet is a fresh start; anything else is a real failure.
    if (
      /does not exist|exists on disk, but not in/u.test(
        String((error as { stderr?: string }).stderr),
      )
    )
      return null;
    throw error;
  }
}

function approver(number: number): string {
  return execFileSync(
    "gh",
    [
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/issues/${number}/events`,
      "--jq",
      `[.[] | select(.event == "labeled" and .label.name == "${approvalLabel}")] | last | .actor.login`,
    ],
    { encoding: "utf8" },
  ).trim();
}

if (import.meta.main) {
  const [base, flag] = process.argv.slice(2);
  const budget: Budget = JSON.parse(readFileSync(budgetUrl, "utf8"));
  const baseList = base && base !== "--write" ? releasePathsAt(".", base) : [];
  const paths = unionOfPaths(releasePaths, baseList);
  const count = countLines(paths, budget);
  if (base === "--write" || flag === "--write") {
    writeFileSync(budgetUrl, JSON.stringify({ ...budget, ...count }, null, 2) + "\n");
    console.log(`budget.json: ${count.lines} source and ${count.testLines} test lines.`);
  } else {
    const event = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request
      : null;
    const pullRequest: PullRequest | null = event
      ? { body: event.body ?? "", labels: event.labels.map((l: { name: string }) => l.name) }
      : null;
    const errors = budgetErrors({
      count,
      budget,
      base: base ? readBase(base) : null,
      droppedPaths: baseList.filter((path) => !releasePaths.includes(path)),
      addedToTombstones: base ? addedToTombstones(base, budget) : [],
      pullRequest,
    });
    for (const error of errors) console.log(`::error::${error}`);
    if (!errors.length)
      console.log(
        `Release tooling: ${count.lines} source and ${count.testLines} test lines, as budgeted.`,
      );
    if (event && pullRequest?.labels.includes(approvalLabel)) {
      const reason = pullRequest.body.match(reuseDecision)?.[1]?.trim().split("\n")[0] ?? "";
      console.log(
        `${approvalLabel} set by ${approver(event.number) || "unknown"}; reuse decision: ${reason}`,
      );
    }
    process.exitCode = errors.length ? 1 : 0;
  }
}
