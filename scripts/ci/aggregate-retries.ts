import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRecord,
  expectedShards,
  filesNamed,
  noticeMessage,
  parseShardRecord,
  type CheckRecord,
  type ShardRecord,
} from "./retry-records.ts";

/**
 * Every shard attempt's retries.json under the download, one per shard and run attempt: a rerun
 * uploads its own, and the attempt before it keeps what it retried.
 */
export function readShardRecords(directory: string, log: (line: string) => void = console.log) {
  const records = new Map<string, ShardRecord>();
  for (const path of filesNamed(directory, "retries.json")) {
    let record;
    try {
      record = parseShardRecord(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      record = undefined;
    }
    const key = record && record.shard + "\0" + record.run_attempt;
    if (record && key && !records.has(key)) records.set(key, record);
    else log(`::warning title=e2e retries::Ignored retry record ${relative(directory, path)}`);
  }
  return [...records.values()];
}

const result = (file: CheckRecord["files"][number]) =>
  file.conclusion === "passed"
    ? "passed on retry"
    : file.retry_outcome === "failed"
      ? "failed twice"
      : "failed, then " + file.retry_outcome.replace("-", " ");

export function summary(record: CheckRecord) {
  const rows = record.files.map(
    (file) =>
      `| ${file.file} | ${file.group} | ${file.shard} | ${file.run_attempt} | ${result(file)} |\n`,
  );
  return (
    "### Declared E2E retries\n\n" +
    `${noticeMessage(record)}, from ${record.received_shards} of ` +
    `${record.expected_shards ?? "an unknown number of"} planned shards.\n` +
    (rows.length
      ? "\n| File | Group | Shard | Run attempt | Result |\n| --- | --- | --- | ---: | --- |\n" +
        rows.join("")
      : "")
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [downloaded, output] = process.argv.slice(2);
  if (!downloaded || !output) throw new Error("Expected the downloaded records and an output path");
  const env = process.env;
  const record = checkRecord(readShardRecords(downloaded), {
    run_id: Number(env.GITHUB_RUN_ID),
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    head_sha: env.HEAD_SHA || env.GITHUB_SHA || "",
    event: env.GITHUB_EVENT_NAME ?? "",
    ref: env.GITHUB_REF ?? "",
    completed_at: new Date().toISOString(),
    expected_shards: expectedShards(env.CI_MATRICES, env.CI_JOBS),
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(record));
  // The check-runs annotations API exposes this total without downloading the artifact.
  console.log(`::notice title=e2e retries::${noticeMessage(record)}`);
}
