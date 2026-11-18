import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, type Bounds } from "./bounded-process.ts";
import { collectNewE2eEvidence, runNames } from "./collect-e2e-evidence.mjs";
import { patternForGroup, readDeclarations } from "./declarations.ts";
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
  /** Set only where this run owns the whole Docker daemon, so leftover e2e databases may go. */
  ownsDocker?: boolean;
};

export type DeclaredResult = DeclaredRun & {
  outcome: "passed" | "failed" | "timed-out" | "cancelled";
  seconds: number;
  code: number | null;
};

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

/**
 * Run one declared (group, file) as its own `e2e:<target>` process, stop everything it started
 * before the next file, and collect only the evidence its runs left.
 */
export async function runDeclaredFile(run: Resolved, options: Options): Promise<DeclaredResult> {
  const log = options.log ?? console.log;
  const destination = join(options.evidence, evidenceDirectory(run));
  const record = (state: object) => {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const text = JSON.stringify({ group: run.group, file: run.file, ...state }) + "\n";
    writeFileSync(join(destination, "declared-run.json"), text);
  };
  const roots = [
    join(options.root, ".generated/e2e-evidence"),
    join(options.root, ".upstream/.local/e2e"),
  ];
  const before = await runNames(roots);
  const started = Date.now();
  record({ outcome: "running", startedAt: new Date(started).toISOString() });
  const exit = options.signal?.aborted
    ? { code: null, stopped: "cancelled" as const }
    : await runBounded(
        "bun",
        [
          "run",
          "e2e:" + run.target,
          "--test-name",
          run.pattern,
          "--workers",
          "1",
          ...flags[run.mode]!,
        ],
        { cwd: join(options.root, ".upstream"), env: await environmentFor(run, options.root) },
        { ...options, log },
      );
  const result: DeclaredResult = {
    group: run.group,
    file: run.file,
    outcome: exit.stopped ?? (exit.code === 0 ? "passed" : "failed"),
    seconds: Math.round((Date.now() - started) / 1000),
    code: exit.code,
  };
  try {
    await collectNewE2eEvidence(roots, before, destination);
  } catch (error) {
    // Missing evidence fails the file, so a pass always comes with its record.
    log(`::error::Could not collect evidence for ${runKey(run)}: ${String(error)}`);
    if (result.outcome === "passed") result.outcome = "failed";
  }
  // A file stopped at its deadline can leave its database containers to the harness's own
  // five-minute sweep; the next file starts without them.
  if (result.outcome !== "passed" && options.ownsDocker) removeLeftoverDatabases(log);
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

const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;

const row = (result: DeclaredResult) =>
  `| ${result.file} | ${result.group} | ${result.outcome} | ${duration(result.seconds)} |\n`;

/** Every file runs even after one fails; the shard fails if any file did not pass. */
export async function runDeclaredShard(runs: readonly DeclaredRun[], options: Options) {
  const log = options.log ?? console.log;
  const resolved = resolveRuns(runs, options.root);
  if (options.summary)
    appendFileSync(
      options.summary,
      "### Declared E2E files\n\n| File | Group | Result | Time |\n| --- | --- | --- | ---: |\n",
    );
  const results: DeclaredResult[] = [];
  for (const run of resolved) {
    log(`::group::${runKey(run)}`);
    const result = await runDeclaredFile(run, options);
    log("::endgroup::");
    log(`${runKey(run)}: ${result.outcome} after ${duration(result.seconds)}`);
    if (result.outcome !== "passed")
      log(
        `::error title=Declared E2E ${result.outcome}::${runKey(run)} ${result.outcome}` +
          (result.outcome === "timed-out" ? " at its per-file deadline" : "") +
          (result.code === null ? "" : ` (exit ${result.code})`) +
          ` after ${duration(result.seconds)}`,
      );
    if (options.summary) appendFileSync(options.summary, row(result));
    results.push(result);
  }
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
    ...(process.env.GITHUB_STEP_SUMMARY ? { summary: process.env.GITHUB_STEP_SUMMARY } : {}),
    ownsDocker: process.env.GITHUB_ACTIONS === "true",
  });
  process.exitCode = results.every((result) => result.outcome === "passed") ? 0 : 1;
}
