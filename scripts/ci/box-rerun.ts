import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// box-rerun.yml, after a Check completes: re-runs a run's jobs on GitHub's runners only when
// box-watch cancelled that run because the box took none of its jobs, proven by box-watch's own
// verdict for that run and attempt. A re-run is a new attempt, which never routes to the box.
// A Check a person cancelled has no verdict; one with a genuine failure keeps it, for a person to
// classify, and its stuck box jobs run when that person re-runs it.

export type Run = { id: number; attempt: number; conclusion: string | null };
export type RerunJob = { id: number; name: string; conclusion: string | null };
export type RerunDecision =
  | { action: "none"; why: string }
  | { action: "report"; why: string; stuck: number[]; failed: string[] }
  | { action: "rerun"; stuck: number[] };

const ids = (value: unknown) =>
  Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id > 0)
    ? (value as number[])
    : undefined;

/** The verdict box-watch wrote, or undefined when the text is not one. */
export function parseVerdict(text: string | undefined) {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const stuck = ids(value.stuck);
    const cutOff = ids(value.cutOff);
    if (
      !Number.isSafeInteger(value.run) ||
      !Number.isSafeInteger(value.attempt) ||
      (value.reason !== "box-down" && value.reason !== "held-past-floor") ||
      !stuck?.length ||
      !cutOff
    )
      return undefined;
    return { run: value.run as number, attempt: value.attempt as number, stuck, cutOff };
  } catch {
    return undefined;
  }
}

export function rerunDecision(
  run: Run,
  verdictText: string | undefined,
  jobs: readonly RerunJob[],
): RerunDecision {
  if (run.conclusion !== "cancelled") return { action: "none", why: "the run was not cancelled" };
  const verdict = parseVerdict(verdictText);
  if (!verdict) return { action: "none", why: "box-watch did not cancel this run" };
  if (verdict.run !== run.id || verdict.attempt !== run.attempt)
    return { action: "none", why: "box-watch's verdict names another run or attempt" };
  const failed = jobs.filter((job) => job.conclusion === "failure").map((job) => job.name);
  if (failed.length)
    return {
      action: "report",
      why: "a job failed for real, so the run stays as it is for a person to classify",
      stuck: verdict.stuck,
      failed,
    };
  return { action: "rerun", stuck: verdict.stuck };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const api = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
  };
  const run: Run = {
    id: Number(env.RUN_ID),
    attempt: Number(env.RUN_ATTEMPT),
    conclusion: env.RUN_CONCLUSION ?? null,
  };
  const path = env.BOX_WATCH_VERDICT ?? "";
  const verdict = path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const response = await fetch(
    `${api}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for the run's jobs`);
  const jobs = ((await response.json()) as { jobs?: RerunJob[] }).jobs ?? [];
  const decision = rerunDecision(run, verdict, jobs);
  const say = (line: string) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n");
  };
  if (decision.action === "none") say(`Box re-run: nothing to do, because ${decision.why}.`);
  else if (decision.action === "report")
    say(
      `Box re-run: not re-running, because ${decision.why} (${decision.failed.join(", ")}). ` +
        `Box jobs that never ran: ${decision.stuck.join(", ")}; they run on GitHub's runners when the run is re-run.`,
    );
  else {
    const rerun = await fetch(`${api}/actions/runs/${run.id}/rerun-failed-jobs`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!rerun.ok) throw new Error(`GitHub returned ${rerun.status} re-running the run`);
    say(
      `Box re-run: re-running the jobs box-watch's cancel stopped, ${decision.stuck.length} of them box jobs that never started, on GitHub's runners.`,
    );
  }
}
