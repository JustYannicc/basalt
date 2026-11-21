import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Production's root runtime runs an older pool than the candidate wants. It was deployed by an
 * older release, and the last release adopted it under its own, different controller code. Two
 * commits reproduce that: the baseline is this tree with `containers/pool/` from before the last
 * pool pin change, and the previous candidate is one empty commit on top of it. The whole
 * directory moves together because carried patches target specific pool versions. The checkout
 * is left at the baseline.
 */
export function commitPreviousCandidate(
  root: string,
  destination: string,
): { baseline: string; previous: string } {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (existsSync(destination)) throw new Error("The previous candidate checkout already exists");
  const change = git(root, [
    "log",
    "-n",
    "1",
    "--format=%H",
    head,
    "--",
    "containers/pool/releases.json",
  ]);
  if (!/^[a-f0-9]{40}$/u.test(change)) throw new Error("No pool pin change to step back from");
  git(root, ["worktree", "add", "--detach", destination, head]);
  git(destination, ["rm", "-r", "-q", "--", "containers/pool"]);
  git(destination, ["checkout", `${change}^`, "--", "containers/pool"]);
  if (!git(destination, ["diff", "--cached", "--name-only"]))
    throw new Error("The previous pool source equals the candidate's");
  const commit = (message: string, ...extra: string[]) => {
    git(destination, [
      "-c",
      "user.name=Release rehearsal",
      "-c",
      "user.email=release-rehearsal@users.noreply.github.com",
      "commit",
      "-q",
      "--no-verify",
      ...extra,
      "-m",
      message,
    ]);
    return git(destination, ["rev-parse", "HEAD"]);
  };
  const baseline = commit("rehearsal: baseline with the previous pool source");
  const previous = commit("rehearsal: previous candidate", "--allow-empty");
  git(destination, ["checkout", "-q", "--detach", baseline]);
  if (
    git(destination, ["rev-parse", `${baseline}^`]) !== head ||
    git(destination, ["rev-parse", `${previous}^`]) !== baseline
  )
    throw new Error("The rehearsal commits are not stacked on the candidate");
  return { baseline, previous };
}

/**
 * A single change rehearsed on its own: the candidate is a merge of that change onto this branch,
 * so its first parent is everything production runs today without it. That is the baseline.
 */
export function checkoutChangeBaseline(root: string, destination: string): string {
  if (existsSync(destination)) throw new Error("The baseline checkout already exists");
  const head = git(root, ["rev-parse", "HEAD"]);
  const parents = git(root, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
  if (parents.length !== 2) throw new Error("A single-change rehearsal needs a merge candidate");
  git(root, ["worktree", "add", "--detach", destination, parents[0]!]);
  return parents[0]!;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: rehearsal-previous.ts DESTINATION [scenario]");
  if (process.argv[3]?.startsWith("single-writer")) {
    process.stdout.write(
      `baseline=${checkoutChangeBaseline(process.cwd(), resolve(destination))}\nsha=\n`,
    );
  } else {
    const { baseline, previous } = commitPreviousCandidate(process.cwd(), resolve(destination));
    process.stdout.write(`baseline=${baseline}\nsha=${previous}\n`);
  }
}
