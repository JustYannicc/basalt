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

type Rerun = { id: string; attempt: number };

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
 * Whether select carried over into re-run attempt `attempt`. "Re-run all jobs" runs select again,
 * and select resolves afresh, so a start job must too. "Re-run failed jobs" carries select and its
 * outputs over, so a start job takes the commit select recorded. Every attempt lists select with
 * its own attempt number and a new job id, but a carried select keeps the start and end times of
 * the attempt it ran in: it started before it was created. A select still queued reports its
 * creation as its start. A listing GitHub can't give leaves today's afresh resolution.
 */
export async function selectCarried(run: Rerun, get: (path: string) => Promise<unknown>) {
  let select: Record<string, unknown>;
  try {
    select = await listedSelect(run, get);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      carried: false,
      note: `::warning::Attempt ${run.attempt}'s jobs are unreadable (${why}); resolving afresh.`,
    };
  }
  const created = Date.parse(String(select.created_at ?? ""));
  const started = Date.parse(String(select.started_at ?? ""));
  if (Number.isNaN(created) || Number.isNaN(started))
    return {
      carried: false,
      note: `::warning::Attempt ${run.attempt} lists select without a start; resolving afresh.`,
    };
  if (started >= created)
    return {
      carried: false,
      note: `select runs again in attempt ${run.attempt}, so this job resolves afresh.`,
    };
  return { carried: true, note: `select ran in an earlier attempt than ${run.attempt}.` };
}

/**
 * The comparison commit a carried select recorded, or "" to resolve afresh. Without a record
 * (an expired artifact, or a reused Check, whose select records nothing) the job resolves afresh:
 * the aggregate still fails a start job whose commit differs from select's, so this never passes
 * a Check that compared with another commit. A main push compares with the push's previous
 * commit, which no later merge moves, so only other runs warn.
 */
export function recordedBase(temp: string, mainPush: boolean) {
  let recorded: Record<string, unknown> | undefined;
  try {
    recorded = record(JSON.parse(readFileSync(recordedSelectionPath(temp), "utf8")));
  } catch {}
  if (typeof recorded?.base === "string" && sha.test(recorded.base))
    return {
      base: recorded.base,
      note: `select ran in an earlier attempt and compared with ${recorded.base}.`,
    };
  const missing = recorded
    ? "its ci-selection artifact records no comparison commit"
    : "this run has no ci-selection artifact";
  return {
    base: "",
    note: mainPush
      ? `select ran in an earlier attempt of a main push, and ${missing}; resolving afresh.`
      : `::warning::select ran in an earlier attempt, but ${missing}; resolving afresh, so the aggregate fails this Check if main moved since. Re-run all jobs then.`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const write = (line: string) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line + "\n");
  };
  if (process.argv[2] === "base") {
    const { base, note } = recordedBase(
      env.RUNNER_TEMP ?? "",
      env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main",
    );
    console.log(note);
    write(`base_sha=${base}`);
  } else {
    const api = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
    };
    const { carried, note } = await selectCarried(
      { id: env.GITHUB_RUN_ID ?? "", attempt: Number(env.GITHUB_RUN_ATTEMPT) },
      async (path) => {
        const response = await fetch(api + path, { headers, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        return response.json();
      },
    );
    console.log(note);
    write(`carried=${carried}`);
  }
}
