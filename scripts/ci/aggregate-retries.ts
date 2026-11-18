import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRecord,
  noticeMessage,
  parseShardRecord,
  type CheckRecord,
  type ShardRecord,
} from "./retry-records.ts";

/** Every shard's retries.json under the download, whether or not each artifact got a directory. */
export function readShardRecords(directory: string, log: (line: string) => void = console.log) {
  const records = new Map<string, ShardRecord>();
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
      else if (entry.isFile() && entry.name === "retries.json") {
        let record;
        try {
          record = parseShardRecord(JSON.parse(readFileSync(child, "utf8")));
        } catch {
          record = undefined;
        }
        if (record && !records.has(record.shard)) records.set(record.shard, record);
        else log(`::warning title=e2e retries::Ignored retry record ${relative(directory, child)}`);
      }
    }
  };
  visit(directory);
  return [...records.values()];
}

export function summary(record: CheckRecord, shards: number) {
  const rows = record.files.map(
    (file) =>
      `| ${file.file} | ${file.group} | ${file.shard} | ` +
      `${file.conclusion === "passed" ? "passed on retry" : "failed twice"} |\n`,
  );
  return (
    "### Declared E2E retries\n\n" +
    `${noticeMessage(record)}, from ${shards} shard records.\n` +
    (rows.length
      ? "\n| File | Group | Shard | Result |\n| --- | --- | --- | --- |\n" + rows.join("")
      : "")
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [downloaded, output] = process.argv.slice(2);
  if (!downloaded || !output) throw new Error("Expected the downloaded records and an output path");
  const env = process.env;
  const shards = readShardRecords(downloaded);
  const record = checkRecord(shards, {
    run_id: Number(env.GITHUB_RUN_ID),
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    head_sha: env.HEAD_SHA || env.GITHUB_SHA || "",
    event: env.GITHUB_EVENT_NAME ?? "",
    ref: env.GITHUB_REF ?? "",
    completed_at: new Date().toISOString(),
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary(record, shards.length));
  // The check-runs annotations API exposes this total without downloading the artifact.
  console.log(`::notice title=e2e retries::${noticeMessage(record)}`);
}
