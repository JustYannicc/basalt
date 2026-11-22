import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
// its log shows the failure of a flake a person classified and listed in tracked-flakes.json (scope
// "job") and no other failure of that kind. Every listed flake names its issue and stops matching
// after its expiry, at most 90 days after it was listed, so none lives there forever. A run with any
// other failed, cancelled or timed-out job stays red for a person to classify.

export type JobFlake = {
  id: string;
  /** A job's name, or a matrix job's id: its legs show as `job (leg)`, a declared job's shards as `job-<n>`. */
  job: string;
  /** Every one of these appears in the failed job's log. */
  match: string[];
  /** Every log line carrying `marker` also carries `allow`: the listed failure is the only one. */
  only: { marker: string; allow: string };
  issue: number;
  /** The day, UTC, a person listed it. */
  listed: string;
  /** The last day, UTC, it matches. */
  expires: string;
};
export type FlakeDecision =
  | { action: "none"; why: string }
  | { action: "report"; why: string }
  | { action: "rerun"; jobs: { id: number; name: string; flake: JobFlake }[]; note: string };

/** How long a listed flake may match before a person lists it again or fixes it. */
export const maxListedDays = 90;
const day = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value));
/** A line break or another control character, which could write past a line into the outputs. */
const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 0x20);
const line = (value: unknown, length: number): value is string =>
  typeof value === "string" && value.trim().length >= length && !hasControl(value);

export function parseJobFlakes(value: unknown) {
  if (!Array.isArray(value)) throw new Error("tracked-flakes.json must be a list");
  const flakes = value
    .filter((entry) => (entry as Record<string, unknown>)?.scope === "job")
    .map((entry: Record<string, unknown>): JobFlake => {
      const { id, job, match, only, issue, listed, expires } = entry;
      const rule = only as Record<string, unknown> | undefined;
      if (
        typeof id !== "string" ||
        !/^[a-z0-9-]+$/.test(id) ||
        typeof job !== "string" ||
        !/^[a-z0-9-]+$/.test(job) ||
        !Array.isArray(match) ||
        !match.length ||
        !match.every((part) => line(part, 12)) ||
        !line(rule?.marker, 4) ||
        !line(rule?.allow, 12) ||
        !Number.isSafeInteger(issue) ||
        (issue as number) <= 0 ||
        !day(listed) ||
        !day(expires) ||
        expires < listed ||
        Date.parse(expires) - Date.parse(listed) > maxListedDays * 86_400_000
      )
        throw new Error(
          `job flake ${String(id)} needs an id, a job, its log signature, the rule that it is the only failure, an issue, and an expiry at most ${maxListedDays} days after it was listed`,
        );
      return {
        id,
        job,
        match: match as string[],
        only: { marker: rule!.marker as string, allow: rule!.allow as string },
        issue: issue as number,
        listed,
        expires,
      };
    });
  if (new Set(flakes.map((flake) => flake.id)).size !== flakes.length)
    throw new Error("tracked-flakes.json lists a job flake twice");
  return flakes;
}

const forJob = (flake: JobFlake, name: string) =>
  name === flake.job || name.startsWith(`${flake.job} (`) || shardJob(name) === flake.job;

/** The listed flakes that could explain this job's failure today, before its log is read. */
export const candidates = (flakes: readonly JobFlake[], name: string, today: string) =>
  flakes.filter((flake) => forJob(flake, name) && flake.listed <= today && today <= flake.expires);

/** Whether the log shows this flake's failure and no other failure of its kind. */
export const explains = (flake: JobFlake, log: string) =>
  flake.match.every((part) => log.includes(part)) &&
  log
    .split("\n")
    .every((text) => !text.includes(flake.only.marker) || text.includes(flake.only.allow));

const shown = (date: string) => date.split("-").reverse().join("-");
// A job name ends up in the re-run job's own name; past this, the note names the flakes only.
const noteLength = 240;

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
  if (jobs.some((job) => hasControl(job.name)))
    return { action: "none", why: "a job's name carries control characters" };
  const jobsOf = jobs.filter((job) => !isCheckJob(job.name));
  // A cancelled or timed-out job is no flake's failure, and re-running failed jobs would re-run it.
  const other = jobsOf.filter(
    (job) => !["success", "skipped", "neutral", "failure"].includes(job.conclusion ?? ""),
  );
  if (other.length)
    return {
      action: "report",
      why: `${other.map((job) => `${job.name} (${job.conclusion ?? "no conclusion"})`).join(", ")} did not fail on a listed flake, so the run stays red for a person to classify`,
    };
  const failed = jobsOf.filter((job) => job.conclusion === "failure");
  if (!failed.length) return { action: "none", why: "no job but the aggregate failed" };
  const matched = failed.map((job) => {
    // Raw job logs carry colour codes inside a line, between the words a signature names.
    const log = stripVTControlCharacters(logs.get(job.id) ?? "");
    const flake = candidates(flakes, job.name, today).find((entry) => explains(entry, log));
    return { id: job.id, name: job.name, flake };
  });
  const unlisted = matched.filter((job) => !job.flake).map((job) => job.name);
  if (unlisted.length)
    return {
      action: "report",
      why: `${unlisted.join(", ")} failed with no listed flake explaining it, so the run stays red for a person to classify`,
    };
  const rerun = matched.map((job) => ({ ...job, flake: job.flake! }));
  const flake = ({ id, issue, expires }: JobFlake) => `${id} (#${issue}, until ${shown(expires)})`;
  const full =
    "Re-ran " +
    rerun.map(({ name, flake: f }) => `${name} for listed flake ${flake(f)}`).join("; ");
  const ids = [...new Map(rerun.map(({ flake: f }) => [f.id, f])).values()];
  return {
    action: "rerun",
    jobs: rerun,
    note:
      full.length <= noteLength
        ? full
        : `Re-ran ${rerun.length} jobs for listed flakes ${ids.map(flake).join(", ")}`,
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
  // Logs are read only when every failed job has a listed flake that could explain it.
  const failed = jobs.filter((job) => job.conclusion === "failure" && !isCheckJob(job.name));
  const logs = new Map<number, string>();
  if (failed.every((job) => candidates(flakes, job.name, today).length))
    for (const job of failed) logs.set(job.id, await jobLog(api, job.id));
  const superseded = await supersededPullRequest(api, run, env);
  const decision = flakeDecision(run, jobs, logs, flakes, today, superseded);
  const output = (key: string, value: string) => {
    const end = `END_${randomBytes(8).toString("hex")}`;
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}<<${end}\n${value}\n${end}\n`);
  };
  output("action", decision.action);
  if (decision.action === "rerun") {
    output("jobs", JSON.stringify(decision.jobs.map((job) => job.id)));
    output("note", decision.note);
    say(`Flake re-run: ${decision.note}.`);
  } else say(`Flake re-run: nothing re-run, because ${decision.why}.`);
}
