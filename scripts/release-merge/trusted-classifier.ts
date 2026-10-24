import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RELEASE_MERGE_POLICY } from "./policy.ts";

/** Run the classifier from an immutable trusted main worktree; candidate files are only git-show inputs. */
export async function classifyCandidateFromTrustedMain(
  repository: string,
  pullRequest: number,
  baseSha: string,
  headSha: string,
  token: string,
): Promise<unknown> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(pullRequest) || pullRequest < 1 || !/^[a-f0-9]{40}$/i.test(baseSha) || !/^[a-f0-9]{40}$/i.test(headSha))
    throw new Error("Trusted classifier inputs are invalid");

  const folder = mkdtempSync(join(tmpdir(), "release-merge-classifier-"));
  const askpass = join(folder, "git-askpass");
  const checkout = join(folder, "trusted-main");
  const prefix = `refs/release-merge/${pullRequest}`;
  const mainRef = `${prefix}/main`;
  const headRef = `${prefix}/head`;
  let worktreeAdded = false;
  let env: NodeJS.ProcessEnv = process.env;
  try {
    writeFileSync(askpass, "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' 'x-access-token' ;; *Password*) printf '%s\\n' \"$GH_TOKEN\" ;; *) exit 1 ;; esac\n", { mode: 0o700 });
    chmodSync(askpass, 0o700);
    env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" };
    const remote = `https://github.com/${repository}.git`;
    git(["fetch", "--no-tags", "--depth=1", remote,
      `+refs/heads/${RELEASE_MERGE_POLICY.baseBranch}:${mainRef}`,
      `+refs/pull/${pullRequest}/head:${headRef}`], env);
    if (git(["rev-parse", "--verify", `${mainRef}^{commit}`], env).trim() !== baseSha ||
      git(["rev-parse", "--verify", `${headRef}^{commit}`], env).trim() !== headSha)
      throw new Error("Fetched refs moved");
    git(["worktree", "add", "--detach", checkout, baseSha], env);
    worktreeAdded = true;
    const output = execFileSync(process.execPath, ["scripts/releases/classify.ts", "--base", baseSha, "--candidate", headSha], {
      cwd: checkout,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error("Fresh release classification failed");
  } finally {
    if (worktreeAdded) {
      try { git(["worktree", "remove", "--force", checkout], env); } catch { /* retain the primary classification failure */ }
    }
    for (const ref of [headRef, mainRef]) {
      try { git(["update-ref", "-d", ref], env); } catch { /* fetched ref may not exist */ }
    }
    rmSync(folder, { recursive: true, force: true });
  }
}

function git(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 2 * 1024 * 1024,
  });
}
