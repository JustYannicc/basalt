import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  passedMainPushCheck,
  passedMainRehearsal,
  type MainCandidateFetch,
} from "./main-candidate.ts";

/**
 * Production write phases run only for a main commit whose push Check and release rehearsal both
 * passed on exactly that commit. `ready` lets Deploy wait quietly for whichever finishes last;
 * `require` refuses, for the jobs that would otherwise go on to back up and deploy.
 */
export async function rehearsalGate(
  env: NodeJS.ProcessEnv,
  mode: string | undefined,
  fetcher: MainCandidateFetch = fetch,
): Promise<{ ready: boolean }> {
  if (mode !== "ready" && mode !== "require")
    throw new Error("usage: rehearsal-gate.ts ready|require");
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const repository = env.GITHUB_REPOSITORY ?? "";
  const candidate = env.RELEASE_CANDIDATE_SHA?.trim() ?? "";
  const [checked, rehearsed] = await Promise.all([
    passedMainPushCheck(repository, token, candidate, fetcher),
    passedMainRehearsal(repository, token, candidate, fetcher),
  ]);
  const ready = checked && rehearsed;
  if (mode === "require" && !ready)
    throw new Error(
      checked
        ? "the release candidate has no passed release rehearsal on main"
        : "the release candidate has no successful push Check",
    );
  // A waiting Deploy run is green but releases nothing; say why where the run is read.
  if (!ready)
    process.stdout.write(
      `::notice::Release waits for ${checked ? "a passed release rehearsal" : "a successful push Check"} of ${candidate}\n`,
    );
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `ready=${ready}\n`, { encoding: "utf8", mode: 0o600 });
  return { ready };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { ready } = await rehearsalGate(process.env, process.argv[2]);
    process.stdout.write(`ready=${ready}\n`);
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : "Release rehearsal gate failed"}`,
    );
    process.exitCode = 1;
  }
}
