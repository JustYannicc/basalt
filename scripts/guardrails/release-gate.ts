import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { limits, readDeployments, releaseHealth, type Deployment } from "./release-health.ts";
import {
  releasePathChange,
  releasePathHash,
  releasePaths,
  releasePathsAt,
  unionOfPaths,
  type PathChange,
} from "./release-path.ts";

// The first step of a production release. A changed release path needs a green rehearsal that
// upgraded from the live commit. Once two deployments in a row have failed, the line is stopped:
// the last good release path still passes; anything else needs proof that the rehearsal now
// catches what production found (it fails on the latest failed candidate) and passes on this one.
// Only a status the Actions bot created counts: a person's token can post any status.
export type Rehearsal = { state: string; description: string; createdAt: string; creator: string };
export type GateInput = {
  candidate: string;
  candidateHash: string;
  lastGood: { sha: string; hash: string } | null;
  consecutiveFailures: number;
  latestFailure: { sha: string; at: string; rehearsals: Rehearsal[] } | null;
  rehearsals: Rehearsal[];
  override: { actor: string; reason: string } | null;
};
export type Verdict = { pass: boolean; reason: string };

export const rehearsalContext = "release-rehearsal";
export const rehearsalCreator = "github-actions[bot]";
export const rehearsalDescription = (hash: string, live: string) =>
  `path ${hash.slice(0, 12)} from ${live.slice(0, 12)}`;

export function decide(input: GateInput): Verdict {
  if (input.override)
    return {
      pass: true,
      reason: `overridden by ${input.override.actor}: ${input.override.reason}`,
    };
  if (!input.lastGood)
    return { pass: false, reason: "no good production deployment to compare with" };
  const stopped = input.consecutiveFailures >= limits.consecutiveFailures;
  if (input.candidateHash === input.lastGood.hash)
    return { pass: true, reason: "release path unchanged since the last good release" };
  const wanted = rehearsalDescription(input.candidateHash, input.lastGood.sha);
  const failure = stopped ? input.latestFailure : null;
  const after = (r: Rehearsal) => !failure || Date.parse(r.createdAt) > Date.parse(failure.at);
  const byBot = (r: Rehearsal) => r.creator === rehearsalCreator;
  const rehearsed = input.rehearsals.some(
    (r) => byBot(r) && r.state === "success" && r.description.includes(wanted) && after(r),
  );
  const reproduced =
    !failure || failure.rehearsals.some((r) => byBot(r) && r.state === "failure" && after(r));
  if (rehearsed && reproduced) return { pass: true, reason: `rehearsed: ${wanted}` };
  if (!stopped)
    return {
      pass: false,
      reason: `the release path changed since the last good release and has no green rehearsal (${wanted})`,
    };
  return {
    pass: false,
    reason: `the line is stopped after ${input.consecutiveFailures} failed production deployments in a row. The release path differs from the last good release, so the rehearsal must first fail on ${failure?.sha.slice(0, 12)}, the latest failed candidate, and then pass on this one (${wanted}), both after ${failure?.at}`,
  };
}

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gh = (args: string[]) => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));

// Judge with the list on both sides, so narrowing release-path.json cannot hide a change. The
// rehearsal workflow takes its hash from `--hash`, which uses the same lists.
const pathsFor = (candidate: string, lastGood: string | undefined) =>
  unionOfPaths(
    releasePaths,
    releasePathsAt(".", candidate),
    lastGood ? releasePathsAt(".", lastGood) : [],
  );

const rehearsalsOf = (repository: string, commit: string): Rehearsal[] =>
  gh(["api", `repos/${repository}/commits/${commit}/statuses?per_page=100`])
    .filter((s: { context: string }) => s.context === rehearsalContext)
    .map(
      (s: {
        state: string;
        description: string | null;
        created_at: string;
        creator: { login: string } | null;
      }) => ({
        state: s.state,
        description: s.description ?? "",
        createdAt: s.created_at,
        creator: s.creator?.login ?? "",
      }),
    );

function inputs(repository: string, candidate: string, deployments: Deployment[]): GateInput {
  const health = releaseHealth(deployments, [], new Date());
  const good = health.lastGood;
  const paths = pathsFor(candidate, good?.sha);
  const failed = deployments.find((d) => d.createdAt === health.latestFailureAt);
  const reason = process.env.OVERRIDE_REASON?.trim();
  return {
    candidate,
    candidateHash: releasePathHash(".", candidate, paths),
    lastGood: good ? { sha: good.sha, hash: releasePathHash(".", good.sha, paths) } : null,
    consecutiveFailures: health.consecutiveFailures,
    latestFailure: failed
      ? { sha: failed.sha, at: failed.createdAt, rehearsals: rehearsalsOf(repository, failed.sha) }
      : null,
    rehearsals: rehearsalsOf(repository, candidate),
    override: reason ? { actor: process.env.TRIGGERING_ACTOR ?? "unknown", reason } : null,
  };
}

function report(input: GateInput, verdict: Verdict, change: PathChange | null) {
  const lines = [
    `Release gate for ${input.candidate.slice(0, 12)}: ${verdict.pass ? "PASS" : "REFUSED"}, ${verdict.reason}.`,
  ];
  if (input.lastGood && change) {
    const commits = git(["rev-list", "--count", `${input.lastGood.sha}..${input.candidate}`]);
    lines.push(
      `Last good release ${input.lastGood.sha.slice(0, 12)}; ${input.consecutiveFailures} failed deployments since.`,
      `Since then: ${commits} commits; the release path changed in ${change.files} files, +${change.added} / -${change.removed} lines.`,
    );
    if (!verdict.pass)
      lines.push(
        `Compare with the last good release first. Default: return the release path to ${input.lastGood.sha.slice(0, 12)} in one PR that touches only release-path files.`,
        `Passes after a green rehearsal of this commit upgrading from ${input.lastGood.sha.slice(0, 12)}, or a dispatch with override_reason.`,
      );
  }
  console.log(lines.join("\n"));
  if (!verdict.pass) console.log(`::error::${lines[0]}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n\n") + "\n");
}

if (import.meta.main) {
  const [flag, value] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY ?? "JustYannicc/basalt";
  if (flag === "--hash") {
    const commit = git(["rev-parse", value ?? "HEAD"]);
    const live = releaseHealth(readDeployments(repository), [], new Date()).lastGood?.sha;
    console.log(releasePathHash(".", commit, pathsFor(commit, live)));
  } else {
    const candidate = git(["rev-parse", flag ?? "HEAD"]);
    const input = inputs(repository, candidate, readDeployments(repository));
    const verdict = decide(input);
    const change = input.lastGood ? releasePathChange(".", input.lastGood.sha, candidate) : null;
    report(input, verdict, change);
    process.exitCode = verdict.pass ? 0 : 1;
  }
}
