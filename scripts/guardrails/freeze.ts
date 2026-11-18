import { execFileSync } from "node:child_process";
import { readHealth, type Health } from "./release-health.ts";
import { shipAlone } from "./ship-alone.ts";

// When merged work has waited 12 hours for a release, main takes only what unblocks the release:
// release-path changes, or a pull request labelled release-unblock (the label event names who).
// The verdict is a commit status, so the scheduled run can also turn open pull requests red.
export const context = "release-freshness";
export const unblockLabel = "release-unblock";

export type FreezeVerdict = { pass: boolean; description: string };

export function freezeVerdict(
  health: Pick<Health, "freeze" | "waitingHours" | "hoursSinceLastGood">,
  files: string[],
  labels: string[],
): FreezeVerdict {
  if (!health.freeze) return { pass: true, description: "Production releases are current." };
  const { releasePath, other } = shipAlone(files);
  if (releasePath.length > 0 && other.length === 0)
    return { pass: true, description: "Frozen, but this changes only the release path." };
  if (labels.includes(unblockLabel))
    return { pass: true, description: `Frozen; passes as ${unblockLabel} (see the label event).` };
  return {
    pass: false,
    description: `Frozen: merged work has waited ${health.waitingHours} h for a release. Only release-path changes or ${unblockLabel} merge.`,
  };
}

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });

function judge(repository: string, health: Health, number: number) {
  const pr = JSON.parse(gh(["api", `repos/${repository}/pulls/${number}`]));
  const files = gh([
    "api",
    "--paginate",
    `repos/${repository}/pulls/${number}/files`,
    "--jq",
    ".[].filename",
  ])
    .split("\n")
    .filter(Boolean);
  const verdict = freezeVerdict(
    health,
    files,
    pr.labels.map((label: { name: string }) => label.name),
  );
  gh([
    "api",
    "-X",
    "POST",
    `repos/${repository}/statuses/${pr.head.sha}`,
    "-f",
    `state=${verdict.pass ? "success" : "failure"}`,
    "-f",
    `context=${context}`,
    "-f",
    `description=${verdict.description.slice(0, 140)}`,
  ]);
  console.log(`#${number} ${verdict.pass ? "pass" : "FROZEN"}: ${verdict.description}`);
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? "JustYannicc/basalt";
  const health = readHealth(repository);
  const target = process.argv[2];
  const numbers = target
    ? [Number(target)]
    : gh([
        "pr",
        "list",
        "--repo",
        repository,
        "--base",
        "main",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number",
        "--jq",
        ".[].number",
      ])
        .split("\n")
        .filter(Boolean)
        .map(Number);
  for (const number of numbers) judge(repository, health, number);
}
