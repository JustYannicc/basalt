import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// GitHub answers 502 to a hundred jobs a page of a re-run Check; fifty works (box-router.ts).
const perPage = 50;
const pages = 10;
const sha = /^[a-f0-9]{40}$/;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Where fast and fast-units download `ci-selection`, the selection select uploads. */
export const recordedSelectionPath = (temp: string) => join(temp, "ci-selection", "selection.json");

type Rerun = { id: string; attempt: number; temp: string; event: string; ref: string };

/** select's entry in attempt `attempt`'s job list, read fifty a page. */
async function listedSelect(run: Rerun, get: (path: string) => Promise<unknown>) {
  for (let page = 1; page <= pages; page++) {
    const jobs = record(
      await get(
        `/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=${perPage}&page=${page}`,
      ),
    ).jobs;
    if (!Array.isArray(jobs)) throw new Error("the listing has no jobs");
    const select = jobs.map(record).find((job) => job.name === "select");
    if (select) return select;
    if (jobs.length < perPage) break;
  }
  throw new Error("the listing has no select job");
}

/**
 * The comparison commit a start job of re-run attempt `attempt` takes, or "" to resolve it afresh.
 * "Re-run all jobs" runs select again, and select resolves afresh, so this job must too. "Re-run
 * failed jobs" carries select and its outputs over, so this job takes the commit select recorded.
 * Every attempt lists select with its own attempt number and a new job id, but a carried select
 * keeps the start and end times of the attempt it ran in: it started before it was created. A
 * listing GitHub can't give, or a select that hasn't started, leaves today's afresh resolution.
 */
export async function rerunBase(run: Rerun, get: (path: string) => Promise<unknown>) {
  const afresh = (note: string) => ({ base: "", note });
  let select: Record<string, unknown>;
  try {
    select = await listedSelect(run, get);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return afresh(
      `::warning::Attempt ${run.attempt}'s jobs are unreadable (${why}); resolving afresh.`,
    );
  }
  const created = Date.parse(String(select.created_at ?? ""));
  const started = Date.parse(String(select.started_at ?? ""));
  if (Number.isNaN(created) || Number.isNaN(started))
    return afresh(
      `::warning::Attempt ${run.attempt} lists select without a start; resolving afresh.`,
    );
  if (started >= created)
    return afresh(`select runs again in attempt ${run.attempt}, so this job resolves afresh.`);
  const path = recordedSelectionPath(run.temp);
  let recorded: Record<string, unknown> | undefined;
  try {
    recorded = record(JSON.parse(readFileSync(path, "utf8")));
  } catch {}
  if (typeof recorded?.base === "string" && sha.test(recorded.base))
    return {
      base: recorded.base,
      note: `select ran in an earlier attempt and compared with ${recorded.base}.`,
    };
  // Only a main push reuses a batch Check, and a reused select records nothing. A main push
  // compares with the push's previous commit, which no later merge moves.
  if (recorded === undefined && run.event === "push" && run.ref === "refs/heads/main")
    return afresh("select ran in an earlier attempt of a main push; resolving afresh.");
  throw new Error(
    `select ran in an earlier attempt, but ${recorded ? "its ci-selection artifact records no comparison commit" : "this run has no ci-selection artifact"}. ` +
      "Resolving afresh could compare with a main that moved since, so re-run all jobs instead.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const api = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
  };
  try {
    const { base, note } = await rerunBase(
      {
        id: env.GITHUB_RUN_ID ?? "",
        attempt: Number(env.GITHUB_RUN_ATTEMPT),
        temp: env.RUNNER_TEMP ?? "",
        event: env.GITHUB_EVENT_NAME ?? "",
        ref: env.GITHUB_REF ?? "",
      },
      async (path) => {
        const response = await fetch(api + path, { headers, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        return response.json();
      },
    );
    console.log(note);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `base_sha=${base}\n`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
