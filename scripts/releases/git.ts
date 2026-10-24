import { execFileSync } from "node:child_process";
import { mkdtempSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubRepository } from "./sources.ts";

export function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
}

export function repositoryFromOrigin(root: string): string {
  return githubRepository(git(root, ["remote", "get-url", "origin"]).trim());
}

export function resetToLatestMain(root: string): string {
  git(root, ["fetch", "--quiet", "origin", "main"]);
  const sha = git(root, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
  git(root, ["checkout", "--quiet", "--detach", sha]);
  git(root, ["reset", "--hard", "--quiet", sha]);
  git(root, ["clean", "-fd", "--quiet", "--", "scripts/releases/receipts"]);
  return sha;
}

export function stageReleaseChanges(root: string, source: "tools" | "home" | "node"): string[] {
  const paths = new Set([
    ...git(root, ["diff", "--name-only"]).trim().split("\n").filter(Boolean),
    ...git(root, ["diff", "--cached", "--name-only"]).trim().split("\n").filter(Boolean),
    ...git(root, ["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean),
  ]);
  if (!paths.size) return [];
  for (const path of paths) {
    if (!allowedReleasePath(path, source)) throw new Error(`Release candidate changed a path outside its updater allowlist: ${path}`);
  }
  git(root, ["add", "-A", "--", ...paths]);
  const rows = git(root, ["diff", "--cached", "--name-status"]).trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
  for (const [status, ...names] of rows) {
    const path = names.at(-1)!;
    if (path.startsWith("patches/") && status !== "D")
      throw new Error("Carried patches may only be removed by a release update");
    if (status === "R" || status === "C") throw new Error("Release updater does not accept file renames");
  }
  return rows.map((row) => row.at(-1)!).sort();
}

export function commitReleaseChanges(root: string, source: "tools" | "home" | "node", releaseKey: string): string {
  git(root, [
    "-c", "user.name=github-actions[bot]",
    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit", "--quiet", "-m", `Update ${releaseKey}`,
  ]);
  const subject = git(root, ["show", "-s", "--format=%s", "HEAD"]).trim();
  if (subject !== `Update ${releaseKey}`) throw new Error("Release update commit subject did not match its receipt");
  return git(root, ["rev-parse", "HEAD"]).trim();
}

export function pushReleaseBranch(
  root: string,
  branch: string,
  previousHead: string | undefined,
  token: string,
): void {
  if (!token) throw new Error("RELEASE_UPDATE_TOKEN is required to push release branches");
  const directory = mkdtempSync(join(tmpdir(), "basalt-release-askpass-"));
  const helper = join(directory, "askpass.sh");
  writeFileSync(helper, `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' "$RELEASE_UPDATE_TOKEN" ;;\nesac\n`);
  chmodSync(helper, 0o700);
  try {
    const lease = `--force-with-lease=refs/heads/${branch}:${previousHead ?? ""}`;
    execFileSync("git", ["push", "--quiet", lease, "origin", `HEAD:refs/heads/${branch}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_ASKPASS: helper, GIT_TERMINAL_PROMPT: "0", RELEASE_UPDATE_TOKEN: token },
    });
  } catch {
    throw new Error("Release branch push failed; the remote branch changed or rejected the candidate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function allowedReleasePath(path: string, source: "tools" | "home" | "node"): boolean {
  return path === "upstream.json" ||
    path === "containers/pool/releases.json" ||
    path === "src/pool/providers.json" ||
    path === "scripts/releases/patches.json" ||
    path === `scripts/releases/receipts/${source}.json` ||
    path === "architecture/gen/stack.gen.c4" ||
    /^patches\/[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/.test(path);
}
