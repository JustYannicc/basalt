import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { isCheckJob, shardJob } from "./retry-history.ts";
import {
  attemptJobs,
  github,
  jobLog,
  say,
  supersededPullRequest,
  triggeringRun,
  type Run,
  type RunJob,
} from "./workflow-run.ts";

// flake-rerun.yml, after a Check fails: re-runs a failed job once, from the first attempt, only when
// its log carries the signature of a flake a person classified and listed in tracked-flakes.json
// (scope "job"). Every listed flake names its issue and stops matching after its expiry date, so
// none lives there forever. A run with any other failure stays red for a person to classify.

export type JobFlake = {
  id: string;
  /** A job's name, or a matrix job's id: its legs show as `job (leg)`, a declared job's shards as `job-<n>`. */
  job: string;
  /** Every one of these appears in the failed job's log. */
  match: string[];
  issue: number;
  /** The last day, UTC, it matches. */
  expires: string;
};
export type FlakeDecision =
  | { action: "none"; why: string }
  | { action: "report"; why: string }
  | { action: "rerun"; jobs: { id: number; name: string; flake: JobFlake }[]; note: string };

const day = /^\d{4}-\d{2}-\d{2}$/;

export function parseJobFlakes(value: unknown) {
  if (!Array.isArray(value)) throw new Error("tracked-flakes.json must be a list");
  const flakes = value
    .filter((entry) => (entry as Record<string, unknown>)?.scope === "job")
    .map((entry: Record<string, unknown>) => {
      const { id, job, match, issue, expires } = entry;
      if (
        typeof id !== "string" ||
        !/^[a-z0-9-]+$/.test(id) ||
        typeof job !== "string" ||
        !/^[a-z0-9-]+$/.test(job) ||
        !Array.isArray(match) ||
        !match.length ||
        !match.every((part) => typeof part === "string" && part.trim().length >= 12) ||
        !Number.isSafeInteger(issue) ||
        (issue as number) <= 0 ||
        typeof expires !== "string" ||
        !day.test(expires) ||
        Number.isNaN(Date.parse(expires))
      )
        throw new Error(
          `job flake ${String(id)} needs an id, a job, its log signature, an issue and an expiry`,
        );
      return { id, job, match: match as string[], issue: issue as number, expires };
    });
  if (new Set(flakes.map((flake) => flake.id)).size !== flakes.length)
    throw new Error("tracked-flakes.json lists a job flake twice");
  return flakes;
}

const forJob = (flake: JobFlake, name: string) =>
  name === flake.job || name.startsWith(`${flake.job} (`) || shardJob(name) === flake.job;

/** The listed flakes that could explain this job's failure today, before its log is read. */
export const candidates = (flakes: readonly JobFlake[], name: string, today: string) =>
  flakes.filter((flake) => forJob(flake, name) && today <= flake.expires);

const shown = (date: string) => date.split("-").reverse().join("-");

export function flakeDecision(
  run: Run,
  jobs: readonly RunJob[],
  logs: ReadonlyMap<number, string>,
  flakes: readonly JobFlake[],
  today: string,
  superseded = false,
): FlakeDecision {
  if (run.conclusion !== "failure") return { action: "none", why: "the run did not fail" };
  if (run.attempt !== 1)
    return { action: "none", why: "a listed flake is re-run once, from the first attempt" };
  if (superseded)
    return {
      action: "none",
      why: "a newer Check runs for this pull request, and a re-run would cancel it",
    };
  const failed = jobs.filter((job) => job.conclusion === "failure" && !isCheckJob(job.name));
  if (!failed.length) return { action: "none", why: "no job but the aggregate failed" };
  const matched = failed.map((job) => {
    // Raw job logs carry colour codes inside a line, between the words a signature names.
    const log = stripVTControlCharacters(logs.get(job.id) ?? "");
    const flake = candidates(flakes, job.name, today).find((entry) =>
      entry.match.every((part) => log.includes(part)),
    );
    return { id: job.id, name: job.name, flake };
  });
  const unlisted = matched.filter((job) => !job.flake).map((job) => job.name);
  if (unlisted.length)
    return {
      action: "report",
      why: `${unlisted.join(", ")} failed with no listed flake's signature, so the run stays red for a person to classify`,
    };
  // Re-running several failed jobs re-runs the cancelled ones too, which no flake explains.
  const cancelled = jobs.filter((job) => job.conclusion === "cancelled" && !isCheckJob(job.name));
  if (matched.length > 1 && cancelled.length)
    return {
      action: "report",
      why: `listed flakes failed ${matched.length} jobs, and re-running them would also re-run the cancelled ${cancelled.map((job) => job.name).join(", ")}`,
    };
  const rerun = matched.map((job) => ({ ...job, flake: job.flake! }));
  return {
    action: "rerun",
    jobs: rerun,
    note:
      "Re-ran " +
      rerun
        .map(
          ({ name, flake }) =>
            `${name} for listed flake ${flake.id} (#${flake.issue}, until ${shown(flake.expires)})`,
        )
        .join("; "),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const api = github(env);
  const run = triggeringRun(env);
  const flakes = parseJobFlakes(
    JSON.parse(readFileSync(new URL("./tracked-flakes.json", import.meta.url), "utf8")),
  );
  const today = new Date().toISOString().slice(0, 10);
  const jobs = await attemptJobs(api, run);
  // Only a failed job a listed flake could explain needs its log read.
  const logs = new Map<number, string>();
  for (const job of jobs)
    if (job.conclusion === "failure" && candidates(flakes, job.name, today).length)
      logs.set(job.id, await jobLog(api, job.id));
  const superseded = await supersededPullRequest(api, run, env);
  const decision = flakeDecision(run, jobs, logs, flakes, today, superseded);
  const output = (key: string, value: string) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  };
  output("action", decision.action);
  if (decision.action === "rerun") {
    output("jobs", JSON.stringify(decision.jobs.map((job) => job.id)));
    output("note", decision.note);
    say(`Flake re-run: ${decision.note}.`);
  } else say(`Flake re-run: nothing re-run, because ${decision.why}.`);
}
