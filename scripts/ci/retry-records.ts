import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const shardFormat = "basalt-e2e-retries-v1";
export const checkFormat = "basalt-check-e2e-retries-v1";

export type RetriedFile = {
  group: string;
  file: string;
  attempts: number;
  conclusion: "passed" | "failed";
  first_failure: string[];
};
export type ShardRecord = { format: string; job: string; shard: string; files: RetriedFile[] };
export type CheckFile = RetriedFile & { job: string; shard: string };
export type CheckMeta = {
  run_id: number;
  run_attempt: number;
  head_sha: string;
  event: string;
  ref: string;
  completed_at: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";

// The artifact is public: parameterized titles can carry fixture accounts, hosts or account ids.
const sensitive = [
  /\S+@\S+/g,
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,
  /\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\b/gi,
  /\b[0-9a-f]{16,}\b/gi,
  /\b[a-z]+_(?=[a-z0-9]*\d)[a-z0-9]{8,}\b/gi,
  /\b\d{6,}\b/g,
];

/** Replace email-, host- and id-like tokens with a marker, and bound the length. */
export function scrubTitle(title: string) {
  let scrubbed = stripVTControlCharacters(title).replace(/\p{Cc}/gu, " ");
  for (const pattern of sensitive) scrubbed = scrubbed.replace(pattern, "[redacted]");
  scrubbed = scrubbed.replace(/\s+/g, " ").trim();
  return scrubbed.length > 200 ? scrubbed.slice(0, 199) + "…" : scrubbed;
}

function reportFailures(path: string) {
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!object(report) || !array(report.testResults)) return [];
  const titles: string[] = [];
  for (const file of report.testResults)
    if (object(file) && array(file.assertionResults))
      for (const test of file.assertionResults)
        if (object(test) && test.status === "failed" && text(test.title)) titles.push(test.title);
  return titles;
}

/**
 * Failing test titles from the Vitest JSON reports (`<target>/report/diagnostics/results.json`)
 * one attempt left. A run that failed before Vitest reported, or only in a hook, yields none.
 */
export function failedTitles(directory: string) {
  const found: string[] = [];
  const visit = (path: string) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name === "results.json" && basename(path) === "diagnostics")
        found.push(...reportFailures(child));
    }
  };
  visit(directory);
  return [...new Set(found.map(scrubTitle).filter(Boolean))].sort().slice(0, 20);
}

export const shardRecord = (job: string, shard: string, files: RetriedFile[]): ShardRecord => ({
  format: shardFormat,
  job,
  shard,
  files,
});

const retriedFile = (value: unknown): value is RetriedFile =>
  object(value) &&
  text(value.group) &&
  text(value.file) &&
  Number.isInteger(value.attempts) &&
  (value.conclusion === "passed" || value.conclusion === "failed") &&
  array(value.first_failure) &&
  value.first_failure.every(text);

export function parseShardRecord(value: unknown): ShardRecord | undefined {
  if (!object(value) || value.format !== shardFormat || !text(value.job) || !text(value.shard))
    return undefined;
  if (!array(value.files) || !value.files.every(retriedFile)) return undefined;
  return { format: shardFormat, job: value.job, shard: value.shard, files: value.files };
}

const order = (a: CheckFile, b: CheckFile) =>
  [a.job, a.shard, a.group, a.file].join("\0") < [b.job, b.shard, b.group, b.file].join("\0")
    ? -1
    : 1;

/** One run's record: every retried file from every shard, with the totals the notice reports. */
export function checkRecord(shards: readonly ShardRecord[], meta: CheckMeta) {
  const files: CheckFile[] = shards
    .flatMap((shard) =>
      shard.files.map((file) => ({
        job: shard.job,
        shard: shard.shard,
        group: file.group,
        file: file.file,
        attempts: file.attempts,
        conclusion: file.conclusion,
        first_failure: file.first_failure,
      })),
    )
    .sort(order);
  return {
    format: checkFormat,
    ...meta,
    retried_files: files.length,
    retried_and_passed: files.filter((file) => file.conclusion === "passed").length,
    failed_twice: files.filter((file) => file.conclusion === "failed").length,
    files,
  };
}

export type CheckRecord = ReturnType<typeof checkRecord>;

const checkFile = (value: unknown): value is CheckFile =>
  object(value) && text(value.job) && text(value.shard) && retriedFile(value);

/** Validate a downloaded run record; its totals are recounted from its files. */
export function parseCheckRecord(value: unknown): CheckRecord | undefined {
  if (!object(value) || value.format !== checkFormat) return undefined;
  if (!array(value.files) || !value.files.every(checkFile)) return undefined;
  const shards = value.files.map((file) => shardRecord(file.job, file.shard, [file]));
  return checkRecord(shards, {
    run_id: Number(value.run_id),
    run_attempt: Number(value.run_attempt),
    head_sha: String(value.head_sha),
    event: String(value.event),
    ref: String(value.ref),
    completed_at: String(value.completed_at),
  });
}

/** The check job's notice; the reader parses it back, so the two stay together. */
export const noticeMessage = (record: CheckRecord) =>
  `${record.retried_and_passed} passed on retry, ${record.failed_twice} failed twice`;

export function parseNoticeMessage(message: string) {
  const match = /^(\d+) passed on retry, (\d+) failed twice$/.exec(message.trim());
  return match ? { passed: Number(match[1]), failed: Number(match[2]) } : undefined;
}

export type RunRetries = { run_id: number; jobs: readonly string[]; files: readonly CheckFile[] };

/**
 * Rank (group, file) pairs by how many runs retried them. A pair's runs are the runs its job ran
 * in: declared shards run only on full-suite runs, which run every declared file.
 */
export function rankRetries(runs: readonly RunRetries[]) {
  const rows = new Map<
    string,
    { job: string; group: string; file: string; runs: Set<number>; passed: number; failed: number }
  >();
  for (const run of runs)
    for (const file of run.files) {
      const key = file.group + " " + file.file;
      const row = rows.get(key) ?? {
        job: file.job,
        group: file.group,
        file: file.file,
        runs: new Set<number>(),
        passed: 0,
        failed: 0,
      };
      rows.set(key, row);
      if (row.runs.has(run.run_id)) continue;
      row.runs.add(run.run_id);
      if (file.conclusion === "passed") row.passed++;
      else row.failed++;
    }
  return [...rows.values()]
    .map((row) => {
      const retries = row.runs.size;
      const ran = Math.max(retries, runs.filter((run) => run.jobs.includes(row.job)).length);
      return {
        job: row.job,
        group: row.group,
        file: row.file,
        retries,
        passed_on_retry: row.passed,
        failed_twice: row.failed,
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
