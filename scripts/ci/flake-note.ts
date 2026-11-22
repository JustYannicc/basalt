import { fileURLToPath } from "node:url";
import { github, say } from "./workflow-run.ts";

// The aggregate of a re-run Check attempt: when flake-rerun.yml started this attempt for a listed
// flake, the run's own summary says which. flake-rerun.yml names its run after the Check run and
// its re-run job after the flakes it re-ran. Informational: any error leaves the summary as it is.

export const flakeRunTitle = (run: number | string) => `Flake re-run for Check run ${run}`;
export const rerunPrefix = "Re-ran ";

export function flakeNote(
  run: number,
  runs: readonly { id?: number; display_title?: string; html_url?: string }[],
  jobsOf: (id: number) => readonly { name?: string; conclusion?: string | null }[] | undefined,
) {
  for (const candidate of runs) {
    if (candidate.display_title !== flakeRunTitle(run) || !candidate.id) continue;
    const rerun = jobsOf(candidate.id)?.find(
      (job) => job.name?.startsWith(rerunPrefix) && job.conclusion === "success",
    );
    if (rerun)
      return `This attempt is a machine re-run. ${rerun.name}; decided in ${candidate.html_url}.`;
  }
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const run = Number(env.GITHUB_RUN_ID);
  try {
    const api = github(env);
    const { workflow_runs: runs = [] } = await api.json<{
      workflow_runs?: { id?: number; display_title?: string; html_url?: string }[];
    }>("/actions/workflows/flake-rerun.yml/runs?event=workflow_run&per_page=50");
    const jobs = new Map<number, { name?: string; conclusion?: string | null }[]>();
    for (const candidate of runs.filter((r) => r.display_title === flakeRunTitle(run) && r.id))
      jobs.set(
        candidate.id!,
        (
          await api.json<{ jobs?: { name?: string; conclusion?: string | null }[] }>(
            `/actions/runs/${candidate.id}/jobs`,
          )
        ).jobs ?? [],
      );
    const note = flakeNote(run, runs, (id) => jobs.get(id));
    if (note) say(note);
  } catch (error) {
    console.log(`No flake note: ${(error as Error).message}`);
  }
}
