import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, type BoundedExit, type Bounds } from "./bounded-process.ts";
import { collectNewE2eEvidence, runNames } from "./collect-e2e-evidence.mjs";
import {
  annotation,
  conclusion,
  duration,
  overflowAnnotation,
  retryAnnotations,
  row,
} from "./declared-report.ts";
import { patternForGroup, readDeclarations } from "./declarations.ts";
import {
  failedTitles,
  retryCounts,
  shardRecord,
  type Outcome,
  type RetriedFile,
} from "./retry-records.ts";
import { fileDeadlineMinutes, runKey, shardRuns, type DeclaredRun } from "./shards.ts";

const flags: Record<string, string[]> = {
  managed: [],
  "rate-limited": ["--auth-rate-limit"],
  "rolled-back": ["--rollback"],
  "oauth-proxy-preview": ["--oauth-proxy-preview"],
  "manual-cron": ["--manual-cron"],
};

export type Options = Omit<Bounds, "log"> & {
  root: string;
  /** Each file's evidence lands in its own subdirectory here. */
  evidence: string;
  /** Workflow commands go here; tests keep them out of their own job's annotations. */
  log?: Bounds["log"];
  /** The step summary, which gets each file's row as soon as that file finishes. */
  summary?: string;
  /** Name the shard's retry record; the workflow passes its job id, matrix shard and run attempt. */
  job?: string;
  shard?: string;
  runAttempt?: number;
  /** Set only where this run owns the whole Docker daemon, so leftover e2e databases may go. */
  ownsDocker?: boolean;
};

export type Attempt = {
  attempt: number;
  outcome: Outcome;
  seconds: number;
  code: number | null;
  /** Why processes this attempt started may still be running. */
  leftover?: string;
};
/** Outcome and exit code are the last attempt's; `seconds` sums every attempt. */
export type DeclaredResult = DeclaredRun & {
  outcome: Outcome;
  seconds: number;
  code: number | null;
  attempts: Attempt[];
  first_failure: string[];
};

/**
 * Only a plain failure gets one more attempt. A file that hangs stays a failure rather than
 * spending another deadline, and a cancelled shard has no time left for one. A file that may have
 * left processes running would start its retry beside them, so it is not retried either.
 */
const retryable = (attempt: Attempt) =>
  attempt.attempt === 1 && attempt.outcome === "failed" && attempt.leftover === undefined;

/** Resolve every pair before anything runs, so a bad row fails without a partial shard. */
export function resolveRuns(runs: readonly DeclaredRun[], root: string) {
  const declarations = readDeclarations(root);
  if (new Set(runs.map(runKey)).size !== runs.length) throw new Error("Duplicate declared run");
  return runs.map((run) => {
    const group = declarations.groups[run.group];
    const entry = declarations.files[run.file];
    if (!group?.matrix || !entry) throw new Error("Unknown declared CI run: " + runKey(run));
    const pattern = patternForGroup(run.group, run.file, root);
    return { ...run, entry, target: group.target, mode: group.mode, pattern };
  });
}

type Resolved = ReturnType<typeof resolveRuns>[number];

async function environmentFor(run: Resolved, root: string) {
  const environment = { ...process.env };
  if (run.entry.fixture === "pool-setup") environment.BASALT_E2E_POOL_SETUP = "1";
  if (run.entry.fixture === "statement-batch") environment.BASALT_E2E_BATCH_STALL = "1";
  if (run.entry.fixture === "google-routes") {
    const { googleMapsAddition } = await import("../../src/catalog/google-maps/index.ts");
    const directory = join(root, ".generated/ci");
    const path = join(directory, "maps-source.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const origin = "https://routes-fixture.invalid";
    const addition = googleMapsAddition(origin);
    const source = { origin, entry: addition.entry, source: addition.source };
    writeFileSync(path, JSON.stringify(source), { mode: 0o600 });
    environment.BASALT_E2E_ROUTES = "1";
    environment.BASALT_E2E_ROUTES_SOURCE_FILE = path;
  }
  return environment;
}

export const evidenceDirectory = (run: DeclaredRun) =>
  run.file + "-" + run.group.replaceAll(":", "-");

/** Each attempt keeps its own evidence, so a pass on retry never replaces the first failure's. */
export const attemptDirectory = (attempt: number) => "attempt-" + attempt;

async function runAttempt(
  run: Resolved,
  attempt: number,
  environment: NodeJS.ProcessEnv,
  options: Options,
  destination: string,
): Promise<Attempt> {
  const log = options.log ?? console.log;
  const roots = [
    join(options.root, ".generated/e2e-evidence"),
    join(options.root, ".upstream/.local/e2e"),
  ];
  const before = await runNames(roots);
  // Locked npm frameworks are test-only registry entries; the wrapper restores product assets after.
  const wrapper =
    run.entry.fixture === "published-frameworks"
      ? [join(options.root, "scripts/ci/with-published-frameworks.ts"), "--", "bun"]
      : [];
  const started = Date.now();
  const exit: BoundedExit = options.signal?.aborted
    ? { code: null, stopped: "cancelled" as const }
    : await runBounded(
        wrapper.length > 0 ? "node" : "bun",
        [
          ...wrapper,
          "run",
          "e2e:" + run.target,
          "--test-name",
          run.pattern,
          "--workers",
          "1",
          ...flags[run.mode]!,
        ],
        { cwd: join(options.root, ".upstream"), env: environment },
        { ...options, log },
      );
  const result: Attempt = {
    attempt,
    // Processes it may have left running could break the next file, so such a run never passes.
    outcome: exit.stopped ?? (exit.code === 0 && !exit.leftover ? "passed" : "failed"),
    seconds: Math.round((Date.now() - started) / 1000),
    code: exit.code,
    ...(exit.leftover && { leftover: exit.leftover }),
  };
  if (exit.leftover)
    log(`::error::${runKey(run)} may have left processes running: ${exit.leftover}`);
  try {
    await collectNewE2eEvidence(roots, before, join(destination, attemptDirectory(attempt)));
  } catch (error) {
    // Missing evidence fails the file, so a pass always comes with its record.
    log(`::error::Could not collect evidence for ${runKey(run)}: ${String(error)}`);
    if (result.outcome === "passed") result.outcome = "failed";
  }
  // A file stopped at its deadline can leave its database containers to the harness's own
  // five-minute sweep; the next attempt or file starts without them.
  if (result.outcome !== "passed" && options.ownsDocker) removeLeftoverDatabases(log);
  return result;
}

/**
 * Run one declared (group, file) as its own `e2e:<target>` process, stop everything it started
 * before the next file, and collect only the evidence its runs left. A plain failure runs once
 * more, immediately, with the same invocation and environment.
 */
export async function runDeclaredFile(run: Resolved, options: Options): Promise<DeclaredResult> {
  const log = options.log ?? console.log;
  const destination = join(options.evidence, evidenceDirectory(run));
  const record = (state: object) => {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const text = JSON.stringify({ group: run.group, file: run.file, ...state }) + "\n";
    writeFileSync(join(destination, "declared-run.json"), text);
  };
  const started = new Date().toISOString();
  const attempts: Attempt[] = [];
  let firstFailure: string[] = [];
  record({ outcome: "running", startedAt: started, attempts });
  const environment = await environmentFor(run, options.root);
  for (let attempt = 1; ; attempt++) {
    log(`::group::${runKey(run)}${attempt > 1 ? " (retry after a failure)" : ""}`);
    const result = await runAttempt(run, attempt, environment, options, destination);
    log("::endgroup::");
    attempts.push(result);
    if (attempt === 1 && result.outcome === "failed")
      firstFailure = failedTitles(join(destination, attemptDirectory(1)));
    if (!retryable(result) || options.signal?.aborted) break;
    log(`${runKey(run)}: failed after ${duration(result.seconds)}; retrying once`);
    record({ outcome: "running", startedAt: started, attempts, first_failure: firstFailure });
  }
  const last = attempts.at(-1)!;
  const result: DeclaredResult = {
    group: run.group,
    file: run.file,
    outcome: last.outcome,
    seconds: attempts.reduce((sum, attempt) => sum + attempt.seconds, 0),
    code: last.code,
    attempts,
    first_failure: firstFailure,
  };
  record(result);
  return result;
}

function removeLeftoverDatabases(log: (line: string) => void) {
  const filter = ["--filter", "label=executor.e2e.role=cloud-postgres"];
  const listed = spawnSync("docker", ["ps", "--all", "--quiet", ...filter], { encoding: "utf8" });
  const ids = listed.status === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : [];
  if (ids.length && spawnSync("docker", ["rm", "--force", ...ids]).status !== 0)
    log("::warning::Could not remove leftover e2e database containers");
}

/**
 * Every file runs even after one fails; the shard fails if any file did not pass. Retried files
 * also land in the shard's retries.json, rewritten after each one so an interrupted shard keeps it.
 */
export async function runDeclaredShard(runs: readonly DeclaredRun[], options: Options) {
  const log = options.log ?? console.log;
  const resolved = resolveRuns(runs, options.root);
  const job = options.job ?? "local";
  const retried: RetriedFile[] = [];
  const saveRetries = () => {
    mkdirSync(options.evidence, { recursive: true, mode: 0o700 });
    const record = shardRecord(job, options.shard ?? job, options.runAttempt ?? 1, retried);
    writeFileSync(join(options.evidence, "retries.json"), JSON.stringify(record) + "\n");
  };
  saveRetries();
  if (options.summary)
    appendFileSync(
      options.summary,
      "### Declared E2E files\n\n| File | Group | Result | Time |\n| --- | --- | --- | ---: |\n",
    );
  const results: DeclaredResult[] = [];
  const unannotated: DeclaredResult[] = [];
  for (const run of resolved) {
    const result = await runDeclaredFile(run, options);
    log(`${runKey(run)}: ${conclusion(result)} after ${duration(result.seconds)}`);
    const line = annotation(result);
    if (result.attempts.length > 1) {
      retried.push({
        group: result.group,
        file: result.file,
        attempts: result.attempts.length,
        conclusion: result.outcome === "passed" ? "passed" : "failed",
        retry_outcome: result.outcome,
        first_failure: result.first_failure,
      });
      saveRetries();
      if (retried.length > retryAnnotations) unannotated.push(result);
      else log(line!);
    } else if (line) log(line);
    if (options.summary) appendFileSync(options.summary, row(result));
    results.push(result);
  }
  if (unannotated.length) log(overflowAnnotation(unannotated));
  log(`Retries: ${retryCounts(retried)}`);
  if (options.summary) appendFileSync(options.summary, `\nRetries: ${retryCounts(retried)}.\n`);
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const runs = shardRuns(process.argv.slice(2).join(" "));
  const controller = new AbortController();
  // The file runs detached, so a terminal's or job's interrupt reaches it only through here.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => controller.abort());
  const results = await runDeclaredShard(runs, {
    root,
    evidence: join(process.env.RUNNER_TEMP ?? join(root, ".generated"), "basalt-e2e-evidence"),
    deadlineMs: fileDeadlineMinutes * 60_000,
    graceMs: 30_000,
    signal: controller.signal,
    ...(process.env.GITHUB_JOB ? { job: process.env.GITHUB_JOB } : {}),
    ...(process.env.BASALT_E2E_SHARD ? { shard: process.env.BASALT_E2E_SHARD } : {}),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    ...(process.env.GITHUB_STEP_SUMMARY ? { summary: process.env.GITHUB_STEP_SUMMARY } : {}),
    ownsDocker: process.env.GITHUB_ACTIONS === "true",
  });
  process.exitCode = results.every((result) => result.outcome === "passed") ? 0 : 1;
}
