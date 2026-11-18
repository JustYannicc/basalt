import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { onReleasePath } from "./release-path.ts";

// The release layer grew 33,600 lines in 12 days, each fix adding machinery. The budget holds the
// source lines of the release path; it may fall freely but rises only with a reuse decision in
// the pull request and the release-budget-approved label. Tombstoned paths take no new lines.
export const approvalLabel = "release-budget-approved";
const budgetUrl = new URL("./budget.json", import.meta.url);
const testFile = /(?:^|\/)(?:test|tests|fixtures|[\w-]+-tests)\/|\.test\.[cm]?[jt]s$/u;
const reuseDecision = /^## Reuse decision\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mu;

export type Budget = { lines: number; tombstones: string[] };
export type PullRequest = { body: string; labels: string[] };

export const tombstoned = (file: string, budget: Budget) =>
  budget.tombstones.some((pattern) => matchesGlob(file, pattern));
export const budgeted = (file: string, budget: Budget) =>
  onReleasePath(file) && !testFile.test(file) && !tombstoned(file, budget);

export function budgetErrors(input: {
  lines: number;
  budget: Budget;
  base: Budget | null;
  addedToTombstones: { file: string; added: number }[];
  pullRequest: PullRequest | null;
}): string[] {
  const { lines, budget, base } = input;
  const errors = input.addedToTombstones.map(
    ({ file, added }) => `${file} adds ${added} lines to a removed path; it takes no new lines.`,
  );
  if (lines < budget.lines)
    errors.push(
      `Release tooling shrank to ${lines} lines: lower "lines" in budget.json to ${lines}.`,
    );
  if (lines > budget.lines)
    errors.push(
      `Release tooling grew to ${lines} lines against a budget of ${budget.lines}. Raise "lines" in budget.json with a reuse decision and the ${approvalLabel} label, or reuse what Cloudflare, Alchemy or a library already does.`,
    );
  const reopened = base ? base.tombstones.filter((path) => !budget.tombstones.includes(path)) : [];
  const raised = base !== null && budget.lines > base.lines;
  if (raised || reopened.length) {
    const what = raised
      ? `raises the budget from ${base!.lines} to ${budget.lines}`
      : `reopens ${reopened.join(", ")}`;
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

export function countLines(budget: Budget): number {
  let lines = 0;
  for (const file of git(["ls-files", "-z"]).split("\0")) {
    if (!file || !budgeted(file, budget)) continue;
    const text = readFileSync(file, "utf8");
    lines += text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }
  return lines;
}

function addedToTombstones(base: string, budget: Budget) {
  return git(["diff", "--numstat", "--no-renames", "-z", `${base}...HEAD`])
    .split("\0")
    .map((record) => record.split("\t"))
    .filter(([added, , file]) => file && Number(added) > 0 && tombstoned(file, budget))
    .map(([added, , file]) => ({ file: file!, added: Number(added) }));
}

if (import.meta.main) {
  const [base, flag] = process.argv.slice(2);
  const budget: Budget = JSON.parse(readFileSync(budgetUrl, "utf8"));
  const lines = countLines(budget);
  if (base === "--write" || flag === "--write") {
    writeFileSync(budgetUrl, JSON.stringify({ ...budget, lines }, null, 2) + "\n");
    console.log(`budget.json: ${lines} lines.`);
  } else {
    let baseBudget: Budget | null = null;
    try {
      if (base)
        baseBudget = JSON.parse(
          execFileSync("git", ["show", `${base}:scripts/guardrails/budget.json`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        );
    } catch {
      // The budget starts with this change.
    }
    const event = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request
      : null;
    const pullRequest = event
      ? { body: event.body ?? "", labels: event.labels.map((l: { name: string }) => l.name) }
      : null;
    const errors = budgetErrors({
      lines,
      budget,
      base: baseBudget,
      addedToTombstones: base ? addedToTombstones(base, budget) : [],
      pullRequest,
    });
    for (const error of errors) console.log(`::error::${error}`);
    if (!errors.length) console.log(`Release tooling: ${lines} of ${budget.lines} budgeted lines.`);
    if (event && pullRequest?.labels.includes(approvalLabel)) {
      const actor = execFileSync(
        "gh",
        [
          "api",
          `repos/${process.env.GITHUB_REPOSITORY}/issues/${event.number}/events`,
          "--jq",
          `[.[] | select(.event == "labeled" and .label.name == "${approvalLabel}")] | last | .actor.login`,
        ],
        { encoding: "utf8" },
      ).trim();
      const reason = pullRequest.body.match(reuseDecision)?.[1]?.trim().split("\n")[0] ?? "";
      console.log(`${approvalLabel} set by ${actor || "unknown"}; reuse decision: ${reason}`);
    }
    process.exitCode = errors.length ? 1 : 0;
  }
}
