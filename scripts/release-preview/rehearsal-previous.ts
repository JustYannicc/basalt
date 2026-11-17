import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Production's root runtime runs an older pool than the candidate wants, and its last release
 * adopted the controller under different controller code. The previous candidate reproduces both:
 * this tree with `containers/pool/` from before the last pool pin change, as its own commit.
 * The whole directory moves together because carried patches target specific pool versions.
 */
export function commitPreviousCandidate(root: string, destination: string): string {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (existsSync(destination)) throw new Error("The previous candidate checkout already exists");
  const change = git(root, ["log", "-n", "1", "--format=%H", head, "--", "containers/pool/releases.json"]);
  if (!/^[a-f0-9]{40}$/u.test(change)) throw new Error("No pool pin change to step back from");
  git(root, ["worktree", "add", "--detach", destination, head]);
  git(destination, ["rm", "-r", "-q", "--", "containers/pool"]);
  git(destination, ["checkout", `${change}^`, "--", "containers/pool"]);
  if (!git(destination, ["diff", "--cached", "--name-only"]))
    throw new Error("The previous pool source equals the candidate's");
  git(destination, [
    "-c",
    "user.name=Release rehearsal",
    "-c",
    "user.email=release-rehearsal@users.noreply.github.com",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "rehearsal: previous candidate with the previous pool source",
  ]);
  const previous = git(destination, ["rev-parse", "HEAD"]);
  if (previous === head || git(destination, ["rev-parse", "HEAD^"]) !== head)
    throw new Error("The previous candidate is not one commit on top of the candidate");
  return previous;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: rehearsal-previous.ts DESTINATION");
  process.stdout.write(`sha=${commitPreviousCandidate(process.cwd(), resolve(destination))}\n`);
}
