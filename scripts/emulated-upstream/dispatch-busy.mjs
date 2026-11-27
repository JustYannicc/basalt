// The hourly expiry's first read: while a person's dispatched run is queued or running, the expiry
// does nothing and the next hour tries again. The expiry has its own concurrency group, so it never
// cancels a queued dispatch, and this check keeps it from removing a stage that run is using.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The dispatched runs not yet completed; a listing without its runs throws. */
// A dispatch waits at most one earlier dispatch's 100-minute job, then runs at most its own: one
// older than that, with an hour to spare, can't be using the stage. So a run stuck waiting (an
// environment approval can wait for days) never holds the expiry past this.
// scripts/emulated-upstream/stage-runs.test.mjs checks it against the job's limit.
export const busyFor = 4 * 60 * 60_000;

/** The dispatched runs on main not yet completed and young enough to matter; a listing without its runs throws. */
export function activeDispatches(body, now = Date.now()) {
  if (!Array.isArray(body?.workflow_runs))
    throw new Error("The workflow's run listing answered without its runs");
  return body.workflow_runs
    .filter(
      (run) =>
        run?.event === "workflow_dispatch" &&
        run.status !== "completed" &&
        run.head_branch === "main" &&
        !(now - Date.parse(run.created_at ?? "") > busyFor),
    )
    .map((run) => ({
      id: Number.isSafeInteger(run.id) ? run.id : "unknown",
      status: /^[a-z_]{1,20}$/u.test(run.status ?? "") ? run.status : "unknown",
    }));
}

async function read(env) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(env.GITHUB_REPOSITORY ?? ""))
    throw new Error("GITHUB_REPOSITORY is not owner/name");
  if (!env.GITHUB_TOKEN) throw new Error("The expiry needs the job's GITHUB_TOKEN to read runs");
  // Newest first; a dispatch still waiting is among the latest, since dispatches run one at a time.
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/emulated-upstream.yml/runs?event=workflow_dispatch&per_page=100&exclude_pull_requests=true`,
    {
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The workflow's run listing failed (HTTP ${response.status})`);
  }
  return activeDispatches(await response.json());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const active = await read(process.env);
  console.log(
    active.length
      ? `- skipped: dispatched run ${active.map((run) => `${run.id} (${run.status})`).join(", ")} is not done; the next hour tries again`
      : "- no dispatched run is queued or running",
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `skip=${active.length ? "true" : "false"}\n`);
}
