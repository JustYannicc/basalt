import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = ".github/workflows/ci.yml";
const sha = /^[a-f0-9]{40}$/;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export type CheckIdentity = {
  repository: string;
  head: string;
  tree: string;
  workflowBlob: string;
};
export type ReuseEvidence = CheckIdentity & {
  runId: number;
  headSha: string;
  workflowId: number;
  branch: string;
};
export type ReuseDecision =
  | { reused: true; evidence: ReuseEvidence }
  | { reused: false; reason: string };

type ReuseContext = CheckIdentity & { event: string; ref: string };
export type ReuseGet = (path: string) => Promise<unknown>;

/** Only a completed batch push from this workflow can stand in for main's full suite. */
export async function decideReuse(context: ReuseContext, get: ReuseGet): Promise<ReuseDecision> {
  const full = (reason: string): ReuseDecision => ({ reused: false, reason });
  if (context.event !== "push" || context.ref !== "refs/heads/main")
    return full("Only main pushes can reuse a batch Check");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ||
    ![context.head, context.tree, context.workflowBlob].every((value) => sha.test(value))
  )
    return full("Invalid candidate identity");
  try {
    const workflow = record(await get("/actions/workflows/ci.yml"));
    if (!positiveId(workflow.id) || workflow.path !== workflowPath)
      return full("Check workflow identity is unavailable");
    // A bounded search may miss an old match; that always costs a full Check, never proof.
    const listing = record(
      await get("/actions/workflows/ci.yml/runs?event=push&status=success&per_page=100"),
    );
    if (!Array.isArray(listing.workflow_runs)) return full("Check run list is unavailable");
    for (const value of listing.workflow_runs) {
      const run = record(value);
      if (
        !positiveId(run.id) ||
        run.workflow_id !== workflow.id ||
        run.path !== workflowPath ||
        run.status !== "completed" ||
        run.conclusion !== "success" ||
        run.event !== "push" ||
        typeof run.head_branch !== "string" ||
        !/^batch\/.+/.test(run.head_branch) ||
        record(run.repository).full_name !== context.repository ||
        record(run.head_repository).full_name !== context.repository ||
        typeof run.head_sha !== "string" ||
        !sha.test(run.head_sha)
      )
        continue;
      const commit = record(await get(`/git/commits/${run.head_sha}`));
      if (commit.sha !== run.head_sha || record(commit.tree).sha !== context.tree) continue;
      const contents = record(await get(`/contents/${workflowPath}?ref=${run.head_sha}`));
      if (contents.type !== "file" || contents.sha !== context.workflowBlob) continue;
      return {
        reused: true,
        evidence: {
          repository: context.repository,
          head: context.head,
          tree: context.tree,
          workflowBlob: context.workflowBlob,
          runId: run.id,
          headSha: run.head_sha,
          workflowId: workflow.id,
          branch: run.head_branch,
        },
      };
    }
    return full("No successful batch Check has the identical tree and workflow");
  } catch {
    return full("Batch Check lookup failed; running the full suite");
  }
}

export function validReuseEvidence(
  value: unknown,
  identity: CheckIdentity,
): value is ReuseEvidence {
  const evidence = record(value);
  return (
    [identity.head, identity.tree, identity.workflowBlob].every((value) => sha.test(value)) &&
    evidence.repository === identity.repository &&
    evidence.head === identity.head &&
    evidence.tree === identity.tree &&
    evidence.workflowBlob === identity.workflowBlob &&
    positiveId(evidence.runId) &&
    positiveId(evidence.workflowId) &&
    typeof evidence.headSha === "string" &&
    sha.test(evidence.headSha) &&
    typeof evidence.branch === "string" &&
    /^batch\/.+/.test(evidence.branch)
  );
}

export function checkedOutIdentity(repository: string): CheckIdentity {
  const git = (ref: string) =>
    execFileSync("git", ["rev-parse", "--verify", ref], { encoding: "utf8" }).trim();
  return {
    repository,
    head: git("HEAD"),
    tree: git("HEAD^{tree}"),
    workflowBlob: git(`HEAD:${workflowPath}`),
  };
}

export function reuseSummary(evidence: ReuseEvidence): string {
  return (
    `Reused full batch Check [${evidence.runId}](https://github.com/${evidence.repository}/actions/runs/${evidence.runId})` +
    ` at \`${evidence.headSha}\` for main \`${evidence.head}\`.\n` +
    `Identical tree: \`${evidence.tree}\`; Check workflow blob: \`${evidence.workflowBlob}\`.\n`
  );
}

export async function runReuseCli(env = process.env): Promise<void> {
  let decision: ReuseDecision = {
    reused: false,
    reason: "Only main pushes can reuse a batch Check",
  };
  if (env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main") {
    try {
      const identity = checkedOutIdentity(env.GITHUB_REPOSITORY ?? "");
      if (identity.head !== env.GITHUB_SHA)
        throw new Error("Checkout differs from the triggering commit");
      const signal = AbortSignal.timeout(90_000);
      decision = await decideReuse(
        { ...identity, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF },
        async (path) => {
          const response = await fetch(
            `https://api.github.com/repos/${identity.repository}${path}`,
            {
              signal,
              redirect: "error",
              headers: {
                Authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            },
          );
          if (!response.ok) throw new Error("Check lookup failed");
          return response.json();
        },
      );
    } catch {
      decision = {
        reused: false,
        reason: "Batch Check identity lookup failed; running the full suite",
      };
    }
  }
  const evidence = decision.reused ? decision.evidence : undefined;
  const output =
    `reused=${decision.reused}\nevidence=${JSON.stringify(evidence ?? null)}\n` +
    `run_id=${evidence?.runId ?? ""}\nhead_sha=${evidence?.headSha ?? ""}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, output);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      evidence ? reuseSummary(evidence) : `${decision.reused ? "" : decision.reason}\n`,
    );
}

export function retainReuseEvidence(evidence: ReuseEvidence, env = process.env): void {
  writeFileSync("check-reuse-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, reuseSummary(evidence));
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `reused_run_id=${evidence.runId}\nreused_head_sha=${evidence.headSha}\n`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runReuseCli();
