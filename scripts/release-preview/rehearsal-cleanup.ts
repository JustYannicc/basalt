import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint } from "./checkpoint.ts";
import { privateOperation } from "./process.ts";
import { parseSubjectArgument, stageNames, type StageSubject } from "../preview/subject.ts";

/** Which rehearsal stages a finished, unsuccessful rehearsal run left a checkpoint for. */
type Run = {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_repository?: { full_name?: unknown };
};

export function rehearsalCleanupRun(
  event: { repository?: { full_name?: unknown }; workflow_run?: Run },
  repository: string,
): number {
  const run = event.workflow_run;
  if (
    event.repository?.full_name !== repository ||
    run?.name !== "Release rehearsal" ||
    run.path !== ".github/workflows/release-rehearsal.yml" ||
    run.status !== "completed" ||
    run.conclusion === "success" ||
    run.head_repository?.full_name !== repository ||
    typeof run.id !== "number" ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1
  )
    throw new Error("Invalid rehearsal cleanup event");
  return run.id;
}

/**
 * The rehearsal's own cleanup job, which runs even when the run was cancelled or timed out, and so
 * covers runs whose rehearsal code is not yet on the default branch.
 */
export function ownRehearsalRun(env: NodeJS.ProcessEnv, repository: string): number {
  const runId = Number(env.GITHUB_RUN_ID);
  if (
    env.GITHUB_JOB !== "cleanup" ||
    !env.GITHUB_WORKFLOW_REF?.startsWith(`${repository}/.github/workflows/release-rehearsal.yml@`) ||
    !Number.isSafeInteger(runId) ||
    runId < 1
  )
    throw new Error("Invalid rehearsal cleanup event");
  return runId;
}

/** A passed scenario proved its own teardown; its receipt names the stage it tore down. */
export function provenTeardown(receipt: unknown, subject: StageSubject): boolean {
  const value = receipt as { version?: unknown; stage?: unknown; teardown?: unknown } | null;
  return value?.version === 1 && value.stage === stageNames(subject).stage && value.teardown === true;
}

/** Checkpoint artifacts are named for their stage and run, so each names exactly one stage. */
export function rehearsalCheckpoints(artifacts: unknown, runId: number): Array<{ id: number; subject: StageSubject }> {
  if (!Array.isArray(artifacts) || artifacts.length >= 100) throw new Error("Invalid rehearsal cleanup artifacts");
  const pattern = new RegExp(`^release-rehearsal-cleanup-(rehearsal-[1-9][0-9]{0,9})-${runId}$`);
  return artifacts.flatMap((item: { id?: unknown; name?: unknown; expired?: unknown } | null) => {
    if (!item || typeof item.name !== "string" || item.expired) return [];
    const match = pattern.exec(item.name);
    const { id } = item;
    if (!match || typeof id !== "number" || !Number.isSafeInteger(id)) return [];
    return [{ id, subject: parseSubjectArgument(match[1]) }];
  });
}

const gh = (path: string) =>
  execFileSync("gh", ["api", path], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_EVENT_PATH || !repository)
    throw new Error("Rehearsal cleanup runs only from a trusted Actions event");
  const runId =
    process.env.GITHUB_EVENT_NAME === "workflow_run"
      ? rehearsalCleanupRun(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")), repository)
      : ownRehearsalRun(process.env, repository);
  const { artifacts } = JSON.parse(gh(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`).toString());
  const root = process.cwd();
  const privateRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "basalt-rehearsal-cleanup-"));
  const failures: unknown[] = [];
  let sequence = 0;
  try {
    await mkdir(join(root, ".local"), { recursive: true, mode: 0o700 });
    // A run cancelled before its checkpoint upload created nothing: the upload precedes any provider write.
    for (const { id, subject } of rehearsalCheckpoints(artifacts, runId)) {
      const { slug } = stageNames(subject);
      const receiptArtifact = (artifacts as Array<{ id?: unknown; name?: unknown; expired?: unknown }>).find(
        (item) => item.name === `release-rehearsal-${slug}` && !item.expired && typeof item.id === "number",
      );
      if (receiptArtifact) {
        const zipPath = join(privateRoot, `${slug}-receipt.zip`);
        await writeFile(zipPath, gh(`repos/${repository}/actions/artifacts/${receiptArtifact.id}/zip`), { mode: 0o600 });
        const text = (() => {
          try {
            return execFileSync("unzip", ["-p", zipPath, "rehearsal-receipt.json"], { encoding: "utf8" });
          } catch {
            return "";
          }
        })();
        let receipt: unknown;
        try { receipt = JSON.parse(text); } catch { receipt = undefined; }
        if (provenTeardown(receipt, subject)) continue;
      }
      // Each stage's failure names its phase with a fixed label; provider output stays in the private logs.
      let phase = "download";
      const operation = (mode: string) =>
        privateOperation({
          label: mode, command: process.execPath, args: ["scripts/preview/lifecycle.ts", mode, slug], directory: root,
          environment: { ...process.env, GITHUB_OUTPUT: undefined, GITHUB_ENV: undefined },
          logPath: join(privateRoot, `${++sequence}-${mode}.log`), timeoutMs: 15 * 60_000,
        });
      try {
        const zipPath = join(privateRoot, `${slug}.zip`);
        await writeFile(zipPath, gh(`repos/${repository}/actions/artifacts/${id}/zip`), { mode: 0o600 });
        const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split(/\r?\n/);
        if (entries.length !== 1 || entries[0] !== "preview-plan.json.enc") throw new Error("Invalid rehearsal checkpoint archive");
        const encryptedPath = join(privateRoot, `${slug}.json.enc`);
        await writeFile(encryptedPath, execFileSync("unzip", ["-p", zipPath, "preview-plan.json.enc"], { maxBuffer: 2 * 1024 * 1024 }), { mode: 0o600 });
        phase = "restore";
        await checkpoint("restore", root, encryptedPath, process.env.PREVIEW_STATE_KEY ?? "", subject);
        phase = "destroy";
        let destroyed = true;
        try { await operation("destroy"); } catch { destroyed = false; }
        phase = destroyed ? "verify" : "destroy and verify";
        await operation("verify");
        if (!destroyed) { phase = "destroy"; throw new Error("destroy"); }
      } catch {
        failures.push(new Error(`${slug}: ${phase} failed`));
      }
    }
    if (failures.length) {
      for (const failure of failures) console.error(`::error::Rehearsal cleanup ${(failure as Error).message}`);
      throw new AggregateError(failures, "Rehearsal cleanup did not finish");
    }
    console.log("Temporary release rehearsal resources are absent");
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("/rehearsal-cleanup.ts")) {
  try { await main(); }
  catch { console.error("Rehearsal cleanup failed; provider resource absence is not established"); process.exitCode = 1; }
}
