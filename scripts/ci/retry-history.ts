import type { CheckFile } from "./retry-records.ts";

/** The declared job a shard's check run belongs to: planShards names shards `<job>-<n>`. */
export const shardJob = (name: string) => /^(declared-[a-z-]+)-\d+$/.exec(name)?.[1];

/** The aggregate job's run, under either name ci.yml's `check` job can show. */
export const isCheckJob = (name: string) => name === "check" || name === "check (fast-only)";

/**
 * One Check run's retries. `jobs` are the declared jobs that ran; `complete` says every planned
 * shard left a record, so a file absent from `files` really was not retried there.
 */
export type RunRetries = {
  run_id: number;
  complete: boolean;
  jobs: readonly string[];
  files: readonly CheckFile[];
};

// One run can retry a file in more than one attempt; the run counts once, as its worst result.
const severity = (file: CheckFile) =>
  file.conclusion === "passed" ? 0 : file.retry_outcome === "failed" ? 2 : 1;

/**
 * Rank (group, file) pairs by how many runs retried them. A pair ran in every complete run its
 * job ran in (declared shards run only on full-suite runs, which run every declared file), and in
 * any incomplete run that retried it; other incomplete runs stay out of its share.
 */
export function rankRetries(runs: readonly RunRetries[]) {
  const rows = new Map<
    string,
    { job: string; group: string; file: string; runs: Map<number, number> }
  >();
  for (const run of runs)
    for (const file of run.files) {
      const key = file.group + " " + file.file;
      const row = rows.get(key) ?? { ...pick(file), runs: new Map<number, number>() };
      rows.set(key, row);
      row.runs.set(run.run_id, Math.max(row.runs.get(run.run_id) ?? 0, severity(file)));
    }
  return [...rows.values()]
    .map((row) => {
      const results = [...row.runs.values()];
      const retries = results.length;
      const ran = runs.filter(
        (run) => (run.complete && run.jobs.includes(row.job)) || row.runs.has(run.run_id),
      ).length;
      return {
        ...pick(row),
        retries,
        passed_on_retry: results.filter((result) => result === 0).length,
        failed_then_stopped: results.filter((result) => result === 1).length,
        failed_twice: results.filter((result) => result === 2).length,
        ran,
        share: retries / ran,
        action: retries / ran > 0.5 ? ("fix-or-quarantine" as const) : undefined,
      };
    })
    .sort(
      (a, b) =>
        b.retries - a.retries ||
        b.failed_twice - a.failed_twice ||
        (a.group + a.file < b.group + b.file ? -1 : 1),
    );
}

const pick = ({ job, group, file }: { job: string; group: string; file: string }) => ({
  job,
  group,
  file,
});
