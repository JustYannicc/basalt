import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const shardFormat = "basalt-e2e-retries-v1";
export const checkFormat = "basalt-check-e2e-retries-v1";

export type Outcome = "passed" | "failed" | "timed-out" | "cancelled";
export type RetriedFile = {
  group: string;
  file: string;
  attempts: number;
  conclusion: "passed" | "failed";
  /** The second attempt's own outcome: a retry that hangs is not a second plain failure. */
  retry_outcome: Outcome;
  first_failure: string[];
};
export type ShardRecord = {
  format: typeof shardFormat;
  job: string;
  shard: string;
  run_attempt: number;
  files: RetriedFile[];
};
export type CheckFile = RetriedFile & { job: string; shard: string; run_attempt: number };
export type CheckMeta = {
  run_id: number;
  run_attempt: number;
  head_sha: string;
  event: string;
  ref: string;
  completed_at: string;
  /** Shards the select job planned, or null when its plan could not be read. */
  expected_shards: number | null;
};
export type CheckRecord = CheckMeta & {
  format: typeof checkFormat;
  received_shards: number;
  complete: boolean;
  retried_files: number;
  retried_and_passed: number;
  failed_twice: number;
  failed_then_stopped: number;
  files: CheckFile[];
};

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const outcomes: readonly unknown[] = ["passed", "failed", "timed-out", "cancelled"];

// The artifact is public: parameterized titles can carry fixture accounts, hosts or account ids.
const sensitive: [RegExp, string][] = [
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
  [/\S+@\S+/g, "[redacted]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[redacted]"],
  [/\blocalhost(?::\d+)?\b/gi, "[redacted]"],
  [/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[redacted]"],
  [/\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\b/gi, "[redacted]"],
  [/\b[0-9a-f]{16,}\b/gi, "[redacted]"],
  [/\b[a-z]+_(?=[a-z0-9]*\d)[a-z0-9]{8,}\b/gi, "[redacted]"],
  [/\b\d{6,}\b/g, "[redacted]"],
];

/** Replace URL-, email-, address-, host- and id-like tokens with a marker, and bound the length. */
export function scrubTitle(title: string) {
  let scrubbed = stripVTControlCharacters(title).replace(/\p{Cc}/gu, " ");
  for (const [pattern, marker] of sensitive) scrubbed = scrubbed.replace(pattern, marker);
  scrubbed = scrubbed.replace(/\s+/g, " ").trim();
  return scrubbed.length > 200 ? scrubbed.slice(0, 199) + "…" : scrubbed;
}

/** Every regular file called `name` under `directory`, which may not exist. */
export function filesNamed(directory: string, name: string) {
  try {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === name)
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return [];
  }
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
  const found = filesNamed(directory, "results.json")
    .filter((path) => basename(join(path, "..")) === "diagnostics")
    .flatMap(reportFailures);
  return [...new Set(found.map(scrubTitle).filter(Boolean))].sort().slice(0, 20);
}

export const shardRecord = (
  job: string,
  shard: string,
  run_attempt: number,
  files: RetriedFile[],
): ShardRecord => ({ format: shardFormat, job, shard, run_attempt, files });

const retriedFile = (value: unknown): value is RetriedFile =>
  object(value) &&
  text(value.group) &&
  text(value.file) &&
  count(value.attempts) &&
  (value.conclusion === "passed" || value.conclusion === "failed") &&
  outcomes.includes(value.retry_outcome) &&
  array(value.first_failure) &&
  value.first_failure.every(text);

export function parseShardRecord(value: unknown): ShardRecord | undefined {
  if (!object(value) || value.format !== shardFormat || !text(value.job) || !text(value.shard))
    return undefined;
  if (!count(value.run_attempt) || !array(value.files) || !value.files.every(retriedFile))
    return undefined;
  return shardRecord(value.job, value.shard, value.run_attempt, value.files);
}

const order = (a: CheckFile, b: CheckFile) =>
  [a.job, a.shard, a.run_attempt, a.group, a.file].join("\0") <
  [b.job, b.shard, b.run_attempt, b.group, b.file].join("\0")
    ? -1
    : 1;

const tally = (files: CheckFile[]) => ({
  retried_files: files.length,
  retried_and_passed: files.filter((file) => file.conclusion === "passed").length,
  failed_twice: files.filter((file) => file.retry_outcome === "failed").length,
  failed_then_stopped: files.filter(
    (file) => file.conclusion === "failed" && file.retry_outcome !== "failed",
  ).length,
});

/**
 * One run's record: the union of every shard attempt's retried files, so a rerun that passes
 * cleanly still shows what the first attempt retried. It is complete only when every planned
 * shard left a record.
 */
export function checkRecord(shards: readonly ShardRecord[], meta: CheckMeta): CheckRecord {
  const files: CheckFile[] = shards
    .flatMap((shard) =>
      shard.files.map((file) => ({
        job: shard.job,
        shard: shard.shard,
        run_attempt: shard.run_attempt,
        group: file.group,
        file: file.file,
        attempts: file.attempts,
        conclusion: file.conclusion,
        retry_outcome: file.retry_outcome,
        first_failure: file.first_failure,
      })),
    )
    .sort(order);
  const received = new Set(shards.map((shard) => shard.shard)).size;
  return {
    format: checkFormat,
    ...meta,
    received_shards: received,
    complete: meta.expected_shards === received,
    ...tally(files),
    files,
  };
}

const checkFile = (value: unknown): value is CheckFile =>
  object(value) &&
  text(value.job) &&
  text(value.shard) &&
  count(value.run_attempt) &&
  retriedFile(value);

/** Validate a downloaded run record; its totals are recounted from its files. */
export function parseCheckRecord(value: unknown): CheckRecord | undefined {
  if (!object(value) || value.format !== checkFormat) return undefined;
  const { run_id, run_attempt, head_sha, event, ref, completed_at, expected_shards } = value;
  if (!count(run_id) || !count(run_attempt) || !text(head_sha) || !text(event) || !text(ref))
    return undefined;
  if (!text(completed_at) || !(expected_shards === null || count(expected_shards)))
    return undefined;
  if (!count(value.received_shards) || typeof value.complete !== "boolean") return undefined;
  if (!array(value.files) || !value.files.every(checkFile)) return undefined;
  const files = [...value.files].sort(order);
  return {
    format: checkFormat,
    run_id,
    run_attempt,
    head_sha,
    event,
    ref,
    completed_at,
    expected_shards,
    received_shards: value.received_shards,
    complete: value.complete,
    ...tally(files),
    files,
  };
}

/** Shards the select job planned for the declared jobs it selected; null if either is unreadable. */
export function expectedShards(matrices: string | undefined, jobs: string | undefined) {
  try {
    const plan: unknown = JSON.parse(matrices ?? "");
    const selected: unknown = JSON.parse(jobs ?? "");
    if (!object(plan) || !array(selected)) return null;
    let total = 0;
    for (const [job, matrix] of Object.entries(plan)) {
      if (!selected.includes(job)) continue;
      if (!object(matrix) || !array(matrix.include)) return null;
      total += matrix.include.length;
    }
    return total;
  } catch {
    return null;
  }
}

/** How a shard's or a run's retried files ended, in the words its summary and notice use. */
export function retryCounts(files: readonly RetriedFile[]) {
  const passed = files.filter((file) => file.conclusion === "passed").length;
  const twice = files.filter((file) => file.retry_outcome === "failed").length;
  const stopped = files.length - passed - twice;
  return (
    `${passed} passed on retry, ${twice} failed twice` +
    (stopped ? `, ${stopped} failed then timed out or cancelled` : "")
  );
}

/** The check job's notice; the reader parses it back, so the two stay together. */
export const noticeMessage = (record: CheckRecord) =>
  retryCounts(record.files) +
  (record.complete
    ? ""
    : ` (incomplete: ${record.received_shards} of ${record.expected_shards ?? "?"} shard records)`);

export function parseNoticeMessage(message: string) {
  const match =
    /^(\d+) passed on retry, (\d+) failed twice(?:, (\d+) failed then timed out or cancelled)?( \(incomplete: \d+ of (?:\d+|\?) shard records\))?$/.exec(
      message.trim(),
    );
  if (!match) return undefined;
  const [passed, failed, stopped] = [match[1], match[2], match[3] ?? "0"].map(Number);
  return { retried: passed! + failed! + stopped!, complete: match[4] === undefined };
}
