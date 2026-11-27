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
 * A row an apply began and did not finish. Most still hold what came before that apply; a
 * `replaced` one holds the new generation, but its apply's clean-up failed, so it did not finish.
 */
const inFlight = new Set(["creating", "updating", "deleting", "replacing", "replaced"]);

/**
 * The commit State's last apply ran, from the plan's own State rows: every settled command that
 * records the release commit (`GITHUB_SHA`, the budget checks that run on every release) must
 * name the same one. Anything else is unknown; no account is read for it. So is any row an apply
 * left unfinished: the commands can have recorded the new commit while that row kept the old
 * code, and every line diffing from the new commit would then miss what that row still lacks.
 */
export function deployedCommit(plan: AlchemyPlan.Plan): string | undefined {
  const named = new Set<string>();
  for (const node of [...Object.values(plan.resources), ...Object.values(plan.deletions)]) {
    const state = node?.state as
      | { resourceType?: unknown; status?: unknown; props?: { env?: Record<string, unknown> } }
      | undefined;
    if (inFlight.has(String(state?.status))) return undefined;
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
 * A patch's sections by the file each changes, without the lines a re-base moves (`index`, hunk
 * offsets), so a carry only re-based or changed in one file names only what really differs.
 */
const patchSections = (patch: string) => {
  const sections = new Map<string, string>();
  // format-patch's signature (`-- ` then the git version) closes the last section, not a file's.
  const body = patch.replace(/\n-- \n[^\n]*\n*$/u, "\n");
  for (const section of body.split(/^(?=diff --git )/mu)) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/mu.exec(section);
    if (!header) continue;
    const body = section
      .split("\n")
      .filter((line) => !line.startsWith("index ") && !line.startsWith("@@"))
      .join("\n");
    for (const target of new Set([header[1]!, header[2]!]))
      sections.set(target, (sections.get(target) ?? "") + body);
  }
  return sections;
};

/** The upstream files two versions of one carry change differently; a patch without git headers, all. */
export const carryTargets = (before: string | undefined, after: string | undefined) => {
  const texts = [before, after].filter((text) => text !== undefined);
  // Sections compare only text git wrote out in full: no binary change (its only difference can be
  // the `index` line) and no file header before the first `diff --git`.
  const whole = (text: string) =>
    /^diff --git /mu.test(text) &&
    !/^(Binary files |GIT binary patch)/mu.test(text) &&
    !/^\+\+\+ /mu.test(text.split(/^diff --git /mu)[0]!);
  // Falling back, every file either kind of header names; a removed line read as one only adds a name.
  const every = (text: string) => [
    ...patchTargets(text),
    ...[...text.matchAll(/^(?:---|\+\+\+) [ab]\/(\S+)/gmu)].map((match) => match[1]!),
  ];
  if (!texts.every(whole)) return [...new Set(texts.flatMap(every))];
  const [from, to] = [before, after].map((text) =>
    text === undefined ? new Map<string, string>() : patchSections(text),
  );
  return [...new Set([...from!.keys(), ...to!.keys()])].filter(
    (target) => from!.get(target) !== to!.get(target),
  );
};

class OutOfTime extends Error {}

/**
 * `git diff --name-only <deployed>..<candidate>` in the checkout, with each changed carry's files.
 * Undefined when either commit is not in the checkout, or when reading them takes past `withinMs`:
 * these calls block, so the deploy's own bound on the reasons cannot cut them short.
 */
export function changedFiles(
  root: string,
  deployed: string | undefined,
  candidate: string,
  withinMs = 30_000,
): ChangedFiles | undefined {
  if (!deployed) return undefined;
  const deadline = Date.now() + withinMs;
  const git = (...args: string[]) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new OutOfTime();
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: left,
    });
  };
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
  try {
    carries(names, from, to, git, deadline, files);
  } catch {
    // Out of time: a partial set would name too few files, so none is named.
    return undefined;
  }
  if (from !== to) for (const file of perReleaseFiles) files.add(file);
  return { deployed: from, files, upstreamPin: names.includes("upstream.json") };
}

function carries(
  names: readonly string[],
  from: string,
  to: string,
  git: (...args: string[]) => string,
  deadline: number,
  files: Set<string>,
) {
  for (const name of names) {
    if (!/^patches\/[^/]+\.patch$/u.test(name)) continue;
    const [before, after] = [from, to].map((commit) => {
      try {
        return git("show", `${commit}:${name}`);
      } catch (error) {
        if (error instanceof OutOfTime || Date.now() >= deadline) throw new OutOfTime();
        // Added or retired in this range: the other side names its files.
        return undefined;
      }
    });
    for (const target of carryTargets(before, after)) files.add(`.upstream/${target}`);
  }
}
