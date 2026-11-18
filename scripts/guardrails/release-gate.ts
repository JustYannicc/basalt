import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { lastGoodDeployment, limits, readDeployments, type Deployment } from "./release-health.ts";
import { releasePathChange, releasePathHash, type PathChange } from "./release-path.ts";

// The first step of a production release. A changed release path needs a green rehearsal that
// upgraded from the live commit. Once two deployments in a row have failed, the line is stopped:
// only the last good release path passes, or a rehearsal taken after the latest failure.
export type Rehearsal = { state: string; description: string; createdAt: string };
export type GateInput = {
  candidate: string;
  candidateHash: string;
  lastGood: { sha: string; hash: string } | null;
  consecutiveFailures: number;
  latestFailureAt: string | null;
  rehearsals: Rehearsal[];
  override: { actor: string; reason: string } | null;
};
export type Verdict = { pass: boolean; reason: string };

export const rehearsalContext = "release-rehearsal";
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
  const rehearsed = input.rehearsals.some(
    (r) =>
      r.state === "success" &&
      r.description.includes(wanted) &&
      (!stopped ||
        !input.latestFailureAt ||
        Date.parse(r.createdAt) > Date.parse(input.latestFailureAt)),
  );
  if (rehearsed) return { pass: true, reason: `rehearsed: ${wanted}` };
  return {
    pass: false,
    reason: stopped
      ? `the line is stopped after ${input.consecutiveFailures} failed production deployments in a row, and the release path differs from the last good release with no rehearsal (${wanted}) newer than the latest failure`
      : `the release path changed since the last good release and has no green rehearsal (${wanted})`,
  };
}

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gh = (args: string[]) => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));

function inputs(repository: string, candidate: string, deployments: Deployment[]): GateInput {
  const now = new Date();
  const good = lastGoodDeployment(deployments, now);
  const failed = deployments.filter(
    (d) => d.state === "failure" && (!good || Date.parse(d.createdAt) > Date.parse(good.createdAt)),
  );
  const statuses = gh(["api", `repos/${repository}/commits/${candidate}/statuses?per_page=100`]);
  const reason = process.env.OVERRIDE_REASON?.trim();
  return {
    candidate,
    candidateHash: releasePathHash(".", candidate),
    lastGood: good ? { sha: good.sha, hash: releasePathHash(".", good.sha) } : null,
    consecutiveFailures: failed.length,
    latestFailureAt:
      failed
        .map((d) => d.createdAt)
        .sort()
        .at(-1) ?? null,
    rehearsals: statuses
      .filter((s: { context: string }) => s.context === rehearsalContext)
      .map((s: { state: string; description: string | null; created_at: string }) => ({
        state: s.state,
        description: s.description ?? "",
        createdAt: s.created_at,
      })),
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
        `Passes with a ${rehearsalContext} commit status on this commit whose description contains "${rehearsalDescription(input.candidateHash, input.lastGood.sha)}", or a dispatch with override_reason.`,
      );
  }
  console.log(lines.join("\n"));
  if (!verdict.pass) console.log(`::error::${lines[0]}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n\n") + "\n");
}

if (import.meta.main) {
  const [flag, value] = process.argv.slice(2);
  if (flag === "--hash") {
    console.log(releasePathHash(".", value ?? "HEAD"));
  } else {
    const repository = process.env.GITHUB_REPOSITORY ?? "JustYannicc/basalt";
    const candidate = git(["rev-parse", flag ?? "HEAD"]);
    const input = inputs(repository, candidate, readDeployments(repository));
    const verdict = decide(input);
    const change = input.lastGood ? releasePathChange(".", input.lastGood.sha, candidate) : null;
    report(input, verdict, change);
    process.exitCode = verdict.pass ? 0 : 1;
  }
}
