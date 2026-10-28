import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateReleaseCandidate, type CandidateValidation } from "./candidate.ts";
import { GitHubApi, type MergeGateApi } from "./github.ts";
import { validateReleaseProofs } from "./proofs.ts";

export type ManualCandidate = {
  pullRequest: number;
  head: string;
  base: string;
  source: "tools" | "home" | "node";
};

export async function validateManualCandidate(
  api: MergeGateApi,
  repository: string,
  pullRequest: number,
  expectedHead?: string,
  expectedBase?: string,
): Promise<ManualCandidate> {
  validateExpectedIdentity(expectedHead, expectedBase);
  const candidate = await validateReleaseCandidate(api, repository, pullRequest, expectedHead);
  requireAllowed(candidate);
  if (expectedBase && candidate.currentMainSha !== expectedBase)
    throw new Error("current main changed since the manual release candidate was backed up");
  const proofs = await validateReleaseProofs(api, repository, candidate);
  if (!proofs.allowed) throw new Error(proofs.reason);

  const fresh = await validateReleaseCandidate(api, repository, pullRequest, expectedHead ?? candidate.headSha);
  requireAllowed(fresh);
  if (fresh.currentMainSha !== candidate.currentMainSha || fresh.headSha !== candidate.headSha)
    throw new Error("pull request head or main changed during manual validation");
  if (expectedBase && fresh.currentMainSha !== expectedBase)
    throw new Error("current main changed since the manual release candidate was backed up");
  const freshProofs = await validateReleaseProofs(api, repository, fresh);
  if (!freshProofs.allowed) throw new Error(freshProofs.reason);

  if (!fresh.headSha || !fresh.currentMainSha || !fresh.source)
    throw new Error("manual release validation did not return complete candidate identity");
  return {
    pullRequest,
    head: fresh.headSha,
    base: fresh.currentMainSha,
    source: fresh.source,
  };
}

function requireAllowed(candidate: CandidateValidation): void {
  if (!candidate.allowed) throw new Error(candidate.reasons.join("; "));
}

export function parseManualPullRequestNumber(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error("pass a positive pull request number");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("pull request number is outside the safe integer range");
  return number;
}

export function parseExpectedManualIdentity(head: string | undefined, base: string | undefined): { head?: string; base?: string } {
  if ((head === undefined) !== (base === undefined)) throw new Error("expected head and base must be supplied together");
  validateExpectedIdentity(head, base);
  return { ...(head ? { head } : {}), ...(base ? { base } : {}) };
}

export function writeManualCandidateOutputs(candidate: ManualCandidate, outputPath?: string): void {
  const lines = manualCandidateOutputLines(candidate);
  if (outputPath) {
    if (!outputPath.startsWith("/")) throw new Error("GITHUB_OUTPUT path must be absolute");
    appendFileSync(outputPath, lines, { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(candidate)}\n`);
}

export function manualCandidateOutputLines(candidate: ManualCandidate): string {
  if (!Number.isSafeInteger(candidate.pullRequest) || candidate.pullRequest < 1 ||
    !/^[a-f0-9]{40}$/i.test(candidate.head) || !/^[a-f0-9]{40}$/i.test(candidate.base) ||
    !["tools", "home", "node"].includes(candidate.source))
    throw new Error("manual candidate output contains invalid values");
  return `pullRequest=${candidate.pullRequest}\nhead=${candidate.head}\nbase=${candidate.base}\nsource=${candidate.source}\n`;
}

export async function runManualCandidateCli(args = process.argv.slice(2), env = process.env): Promise<void> {
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const pullRequest = parseManualPullRequestNumber(args[0] ?? env.MANUAL_RELEASE_PR);
  const expected = parseExpectedManualIdentity(
    args[1] ?? env.MANUAL_RELEASE_EXPECTED_HEAD,
    args[2] ?? env.MANUAL_RELEASE_EXPECTED_BASE,
  );
  const candidate = await validateManualCandidate(
    new GitHubApi(env.GH_TOKEN ?? env.GITHUB_TOKEN),
    repository,
    pullRequest,
    expected.head,
    expected.base,
  );
  writeManualCandidateOutputs(candidate, env.GITHUB_OUTPUT);
}

function validateExpectedIdentity(head?: string, base?: string): void {
  if ((head === undefined) !== (base === undefined)) throw new Error("expected head and base must be supplied together");
  if (head !== undefined && (!/^[a-f0-9]{40}$/i.test(head) || !/^[a-f0-9]{40}$/i.test(base!)))
    throw new Error("expected head and base must be full commit SHAs");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runManualCandidateCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
