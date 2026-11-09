import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A stale PR head does not contain the production declarations introduced on main. */
export function assertProbeCandidate(root: string, head: string) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Baseline probe needs an exact PR head");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const candidate = git("rev-parse", "HEAD");
  const main = git("rev-parse", "refs/remotes/origin/main");
  const parents = git("show", "--no-patch", "--format=%P", candidate).split(" ");
  if (parents.length !== 2 || parents[0] !== main || parents[1] !== head)
    throw new Error(
      `Baseline probe requires current main ${main} merged with PR head ${head}; candidate ${candidate} has parents ${parents.join(",")}`,
    );
  return { schemaVersion: 1, candidate, main, head };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = assertProbeCandidate(process.cwd(), process.env.BASALT_PROBE_HEAD ?? "");
  mkdirSync(".local", { recursive: true });
  writeFileSync(join(".local", "probe-candidate.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    `Baseline probe candidate ${receipt.candidate}; current main ${receipt.main}; PR head ${receipt.head}`,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `candidate=${receipt.candidate}\n`);
}
