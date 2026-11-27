import { execFileSync } from "node:child_process";
import type * as AlchemyPlan from "alchemy/Plan";

/**
 * The files a release changes since the commit production runs now, as repository paths. Files of
 * the prepared upstream tree are named `.upstream/<path>`: this repository holds them only as
 * carried patches, so a changed patch stands for every file it touches, in either version.
 */
export interface ChangedFiles {
  readonly deployed: string;
  readonly files: ReadonlySet<string>;
  /** The upstream pin moved, so prepared files no patch names can differ too. */
  readonly upstreamPin: boolean;
}

const SHA = /^[a-f0-9]{40}$/u;

/**
 * Written by the upstream preparation from the release commit itself (prepare-upstream.ts), so
 * they differ between any two releases although no commit changes them.
 */
export const perReleaseFiles = [
  ".upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts",
  ".upstream/apps/hosted/server/src/implementation/catalog-app-release.ts",
  ".upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts",
];

/**
 * The commit State's last apply ran, from the plan's own State rows: every settled command that
 * records the release commit (`GITHUB_SHA`, the budget checks that run on every release) must
 * name the same one. Anything else is unknown; no account is read for it.
 */
export function deployedCommit(plan: AlchemyPlan.Plan): string | undefined {
  const named = new Set<string>();
  for (const node of [...Object.values(plan.resources), ...Object.values(plan.deletions)]) {
    const state = node?.state as
      | { resourceType?: unknown; status?: unknown; props?: { env?: Record<string, unknown> } }
      | undefined;
    if (state?.resourceType !== "Command.Exec") continue;
    if (state.status !== "created" && state.status !== "updated") continue;
    const sha = state.props?.env?.GITHUB_SHA;
    if (sha !== undefined) named.add(String(sha));
  }
  const [only, ...rest] = named;
  return only !== undefined && rest.length === 0 && SHA.test(only) ? only : undefined;
}

/**
 * The files a patch changes, by the paths its headers name (relative to the upstream root). Git's
 * own headers when it has them: a removed line can also start with `--- a/`.
 */
export const patchTargets = (patch: string) => {
  const git = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)];
  const headers = git.length
    ? git.flatMap((match) => [match[1]!, match[2]!])
    : [...patch.matchAll(/^(?:---|\+\+\+) [ab]\/(\S+)/gmu)].map((match) => match[1]!);
  return [...new Set(headers)];
};

/**
 * `git diff --name-only <deployed>..<candidate>` in the checkout, with each changed carry's files.
 * Undefined when either commit is not in the checkout.
 */
export function changedFiles(
  root: string,
  deployed: string | undefined,
  candidate: string,
): ChangedFiles | undefined {
  if (!deployed) return undefined;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  let from: string;
  let to: string;
  let names: string[];
  try {
    from = git("rev-parse", "--verify", `${deployed}^{commit}`).trim();
    to = git("rev-parse", "--verify", `${candidate}^{commit}`).trim();
    names = git("diff", "--name-only", "--no-renames", "-z", `${from}..${to}`)
      .split("\0")
      .filter(Boolean);
  } catch {
    return undefined;
  }
  const files = new Set(names);
  for (const name of names) {
    if (!/^patches\/[^/]+\.patch$/u.test(name)) continue;
    for (const commit of [from, to]) {
      let text: string;
      try {
        text = git("show", `${commit}:${name}`);
      } catch {
        // Added or retired in this range: the other side names its files.
        continue;
      }
      for (const target of patchTargets(text)) files.add(`.upstream/${target}`);
    }
  }
  if (from !== to) for (const file of perReleaseFiles) files.add(file);
  return { deployed: from, files, upstreamPin: names.includes("upstream.json") };
}
