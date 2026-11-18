import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  parseCheckRecord,
  parseNoticeMessage,
  rankRetries,
  type RunRetries,
} from "./retry-records.ts";

const repository = "JustYannicc/basalt";
const exec = promisify(execFile);

const transient = (error: unknown) =>
  /HTTP 5\d\d|HTTP 429|ECONNRESET|ETIMEDOUT/.test(String((error as { stderr?: unknown }).stderr));

/** GitHub's API returns the odd 5xx under load; a run's read is retried rather than lost. */
async function gh(args: string[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await exec("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
    } catch (error) {
      if (attempt >= 4 || !transient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}
/** `gh api --paginate --jq` prints one JSON value per line across every page. */
const values = async (path: string, jq: string) =>
  (await gh(["api", "--paginate", path, "--jq", jq]))
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type Job = { id: number; name: string; conclusion: string | null };
const job = (value: unknown): value is Job =>
  object(value) &&
  typeof value.id === "number" &&
  typeof value.name === "string" &&
  (value.conclusion === null || typeof value.conclusion === "string");

async function downloadRecord(run: number) {
  const directory = await mkdtemp(join(tmpdir(), "basalt-check-retries-"));
  try {
    await gh([
      "run",
      "download",
      String(run),
      "-R",
      repository,
      "-n",
      "check-e2e-retries",
      "-D",
      directory,
    ]);
    return parseCheckRecord(JSON.parse(await readFile(join(directory, "retries.json"), "utf8")));
  } catch {
    // Runs from before the record existed, or past its retention, have none.
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Lookup = { kind: "none" } | { kind: "unrecorded" } | { kind: "recorded"; run: RunRetries };

/** The check job's notice decides whether a run needs its artifact downloaded at all. */
async function lookup(run: number, suite: number): Promise<Lookup> {
  // A job's check run carries its name and conclusion without its steps, so a full run's few
  // hundred jobs list in seconds where the jobs endpoint takes half a minute.
  const jobs = (
    await values(
      `repos/${repository}/check-suites/${suite}/check-runs?per_page=100&filter=latest`,
      ".check_runs[] | {id, name, conclusion}",
    )
  ).filter(job);
  const declared = new Set<string>();
  for (const { name, conclusion } of jobs) {
    const shard = /^(declared-[a-z-]+)-\d+$/.exec(name);
    if (shard && (conclusion === "success" || conclusion === "failure")) declared.add(shard[1]!);
  }
  if (!declared.size) return { kind: "none" };
  const check = jobs.find(({ name }) => /^check(?: \(fast-only\))?$/.test(name));
  const notices = check
    ? await values(
        `repos/${repository}/check-runs/${check.id}/annotations?per_page=100`,
        '.[] | select(.title == "e2e retries") | {message}',
      )
    : [];
  const totals = notices
    .map((notice) => (object(notice) ? parseNoticeMessage(String(notice.message)) : undefined))
    .find(Boolean);
  if (totals && totals.passed + totals.failed === 0)
    return { kind: "recorded", run: { run_id: run, jobs: [...declared], files: [] } };
  const record = await downloadRecord(run);
  return record
    ? { kind: "recorded", run: { run_id: run, jobs: [...declared], files: record.files } }
    : { kind: "unrecorded" };
}

async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const day = (value: string | undefined, name: string) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new Error(`Expected --${name} YYYY-MM-DD`);
  return value;
};

function table(rows: ReturnType<typeof rankRetries>) {
  const header = ["retries", "passed on retry", "failed twice", "runs", "share", "group", "file"];
  const lines = rows.map((row) => [
    String(row.retries),
    String(row.passed_on_retry),
    String(row.failed_twice),
    String(row.ran),
    `${Math.round(row.share * 100)}%`,
    row.group,
    row.file + (row.action ? "  " + row.action : ""),
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...lines.map((line) => line[index]!.length)),
  );
  return [header, ...lines]
    .map((line) =>
      line
        .map((cell, index) => cell.padEnd(widths[index]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

async function main() {
  const { values: flags } = parseArgs({
    options: { since: { type: "string" }, until: { type: "string" } },
  });
  const since = day(flags.since, "since");
  const until = day(flags.until ?? new Date().toISOString().slice(0, 10), "until");
  const runs = (
    await values(
      `repos/${repository}/actions/workflows/ci.yml/runs?status=completed&created=${since}..${until}&per_page=100`,
      ".workflow_runs[] | {id, conclusion, check_suite_id}",
    )
  ).filter(
    (run): run is { id: number; conclusion: string; check_suite_id: number } =>
      object(run) &&
      typeof run.id === "number" &&
      typeof run.check_suite_id === "number" &&
      (run.conclusion === "success" || run.conclusion === "failure"),
  );
  const lookups = await pool(runs, 6, (run) => lookup(run.id, run.check_suite_id));
  const recorded = lookups.flatMap((item) => (item.kind === "recorded" ? [item.run] : []));
  const unrecorded = lookups.filter((item) => item.kind === "unrecorded").length;
  console.log(
    `Check runs ${since}..${until}: ${runs.length} finished, ` +
      `${recorded.length + unrecorded} ran declared e2e, ${unrecorded} of those without a retry record.`,
  );
  const rows = rankRetries(recorded);
  console.log(rows.length ? table(rows) : "No declared e2e file was retried.");
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
