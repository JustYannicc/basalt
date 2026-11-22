import { execFileSync, spawnSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { areas, heavyJobs, selectionInputs, sharedInputs, staticInputs } from "./areas.ts";
import { declarationJobs, matchingDeclarations } from "./declarations.ts";
import { dependents, isCode } from "./import-graph.ts";
import { addTo, carryTargets, frozenInputMatcher, isRelativeInput } from "./inputs.ts";
import { checkWorkflow as workflow, parseWorkflow, readWorkflow } from "./job-inputs.ts";
import { reach } from "./reach.ts";

export { carryTargets } from "./inputs.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const matches = (file: string, patterns: readonly string[]) =>
  patterns.some((pattern) => matchesGlob(file, pattern));
const noHeavyJob = [...staticInputs, ...selectionInputs];

const jobInput = (job: string) => workflow + "#" + job;
const changedJob = (path: string) =>
  path.startsWith(workflow + "#") ? path.slice(workflow.length + 1) : undefined;

/**
 * What a change to the Check workflow touches: each job whose own block differs, compared parsed,
 * so comments and layout count for nothing. Triggers, concurrency, permissions, env and defaults
 * apply to every job, so a change outside the jobs, or a side that doesn't parse, is the workflow
 * file itself, which selects every job.
 */
export function workflowInputs(base: string, head: string): string[] {
  const [before, after] = [base, head].map((text) => {
    try {
      const parsed = parseWorkflow(text);
      return parsed?.jobs && typeof parsed.jobs === "object" ? parsed : null;
    } catch {
      return null;
    }
  });
  if (!before || !after) return [workflow];
  const { jobs: was, ...settings } = before;
  const { jobs: is, ...settingsNow } = after;
  if (!isDeepStrictEqual(settings, settingsNow)) return [workflow];
  return [...new Set([...Object.keys(was), ...Object.keys(is)])]
    .filter((job) => !isDeepStrictEqual(was[job], is[job]))
    .sort()
    .map(jobInput);
}

/**
 * The heavy jobs a change's paths reach. Shared inputs select every job; static inputs and the
 * scripts that select and gate jobs none. A changed Check job block selects that job and the jobs
 * that need it. A code file selects the jobs whose inputs import or read it, directly or
 * transitively; one that reaches only fast jobs' tests runs nothing heavy. Other paths keep their
 * area and scenario declarations. Whatever none of these resolves selects every job.
 */
export function selectPaths(
  paths: readonly string[],
  root = repository,
): { declaredFiles: string[] | null; jobs: string[]; reasons: Record<string, string[]> } {
  const sorted = [...new Set(paths)].sort();
  if (sorted.some((path) => !isRelativeInput(path)))
    throw new Error("Changed path escapes the repository");
  const files = sorted.filter((path) => changedJob(path) === undefined);
  const blocks = sorted.flatMap((path) => {
    const job = changedJob(path);
    return job === undefined ? [] : [{ path, job }];
  });
  // A shared input runs every heavy job and a static one none; neither needs the graph.
  const shared = files.filter((path) => matches(path, sharedInputs));
  if (shared.length)
    return {
      declaredFiles: null,
      jobs: [...heavyJobs],
      reasons: Object.fromEntries(heavyJobs.map((job) => [job, shared])),
    };
  const reasons = new Map<string, Set<string>>();
  const declaredFiles = new Set<string>();
  let complete = false;
  const select = (jobs: Iterable<string>, path: string) => {
    for (const job of jobs) {
      if (!heavyJobs.includes(job)) throw new Error("Unknown CI job in area declaration");
      // A declared job reached other than through its scenarios plans every declared file.
      if (job.startsWith("declared-")) complete = true;
      addTo(reasons, job, path);
    }
  };
  const scenario = (entries: readonly { file: string; jobs: string[] }[], path: string) => {
    for (const entry of entries) {
      declaredFiles.add(entry.file);
      for (const job of entry.jobs) if (job !== "fast") addTo(reasons, job, path);
    }
  };
  const result = () => ({
    declaredFiles: complete ? null : [...declaredFiles].sort(),
    jobs: heavyJobs.filter((job) => reasons.has(job)),
    reasons: Object.fromEntries([...reasons].map(([job, paths]) => [job, [...paths]])),
  });
  // A job's result and outputs decide whether and how the jobs that need it run, so a changed
  // block selects them too, deliberately so for `select`, `reuse` and `long-started`, whose
  // results gate every job or most of them; a matrix job runs every leg. The fast jobs and the
  // aggregate run in every Check.
  if (blocks.length) {
    const needers = new Map<string, Set<string>>();
    for (const [job, { needs }] of Object.entries(readWorkflow(root).jobs))
      for (const need of [needs ?? []].flat()) addTo(needers, need, job);
    for (const { path, job } of blocks)
      select(
        [...dependents(needers, [job])].filter((needer) => heavyJobs.includes(needer)),
        path,
      );
  }
  const remaining = files.filter((path) => !matches(path, noHeavyJob));
  if (!remaining.length) return result();
  const model = reach(root);
  const { declarations } = model;
  const frozenInput = frozenInputMatcher(root);
  // What the files that import or read a path reach; whether any of them resolves it.
  const reached = (path: string) => {
    let resolved = false;
    for (const file of dependents(model.graph.importers, [path])) {
      const jobs = model.jobs.get(file);
      if (jobs?.size) select(jobs, path);
      for (const spec of model.scenarios.get(file) ?? [])
        scenario(
          [{ file: spec, jobs: declarationJobs(declarations.files[spec]!, declarations) }],
          path,
        );
      resolved ||= !!jobs?.size || model.scenarios.has(file) || model.fast.has(file);
    }
    return resolved;
  };
  for (const path of remaining) {
    const upstream = path.startsWith(".upstream/");
    // A code file in the candidate reaches its jobs through the files that import it, its own
    // areas and declarations included. A deleted one has no importers left; its paths decide.
    if (isCode(path) && !upstream && model.graph.files.has(path)) {
      if (!reached(path)) {
        complete = true;
        select(heavyJobs, path);
      }
      continue;
    }
    const declared = matchingDeclarations(path, declarations);
    scenario(declared, path);
    if (
      /^(?:\.upstream\/e2e\/tests\/|e2e\/plans\/)/.test(path) &&
      declared.some((entry) => entry.jobs.length)
    )
      continue;
    reached(path);
    const affected = areas.filter((area) => matches(path, area.paths));
    // Upstream area heuristics cannot establish that every dependent scenario is declared.
    const covered =
      frozenInput(path) &&
      (declared.some((entry) => entry.jobs.length) || (!upstream && affected.length > 0));
    if (!covered) complete = true;
    select(covered ? affected.flatMap((area) => area.jobs) : heavyJobs, path);
  }
  return result();
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function content(root: string, ref: string, path: string) {
  const result = spawnSync("git", ["show", ref + ":" + path], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === 128) return "";
  if (result.status !== 0) throw new Error("Could not read a changed file at a compared commit");
  return result.stdout;
}

export function changedInputs(root: string, base: string, head: string) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("CI selection needs immutable commits");
  const changed = git(root, ["diff", "--no-renames", "--name-only", "-z", base + "..." + head])
    .split("\0")
    .filter(Boolean);
  const inputs = new Set<string>();
  for (const path of changed) {
    if (path === workflow) {
      for (const input of workflowInputs(content(root, base, path), content(root, head, path)))
        inputs.add(input);
      continue;
    }
    if (!/^patches\/\d{4}-.+\.(?:patch|json)$/.test(path)) {
      inputs.add(path);
      continue;
    }
    const carry = path.replace(/\.json$/, ".patch");
    let found = false;
    for (const ref of [base, head]) {
      const source = content(root, ref, carry);
      if (source) {
        found = true;
        for (const target of carryTargets(source)) inputs.add(target);
      }
    }
    if (!found) throw new Error("Changed carry record has no patch at either commit");
  }
  return { changed, inputs: [...inputs].sort() };
}
