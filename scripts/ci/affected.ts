import { execFileSync, spawnSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { areas, heavyJobs, sharedInputs, staticInputs } from "./areas.ts";
import { matchingDeclarations, readDeclarations } from "./declarations.ts";
import { configuredBoatJobs as parseBoatJobs } from "./boat.ts";
import { carryTargets, frozenInputMatcher, isRelativeInput } from "./inputs.ts";

export { carryTargets } from "./inputs.ts";

const matches = (file: string, patterns: readonly string[]) =>
  patterns.some((pattern) => matchesGlob(file, pattern));

export function selectPaths(paths: readonly string[]) {
  const declarations = readDeclarations();
  const frozenInput = frozenInputMatcher(fileURLToPath(new URL("../../", import.meta.url)));
  const reasons = new Map<string, Set<string>>();
  const declaredFiles = new Set<string>();
  let complete = false;
  const select = (jobs: readonly string[], path: string) => {
    for (const job of jobs) {
      if (!heavyJobs.includes(job)) throw new Error("Unknown CI job in area declaration");
      const previous = reasons.get(job) ?? new Set<string>();
      previous.add(path);
      reasons.set(job, previous);
    }
  };
  for (const path of [...new Set(paths)].sort()) {
    if (!isRelativeInput(path)) throw new Error("Changed path escapes the repository");
    const declared = matchingDeclarations(path, declarations);
    for (const entry of declared) {
      declaredFiles.add(entry.file);
      select(
        entry.jobs.filter((job) => job !== "fast"),
        path,
      );
    }
    if (
      /^(?:\.upstream\/e2e\/tests\/|e2e\/plans\/)/.test(path) &&
      declared.some((entry) => entry.jobs.length)
    )
      continue;
    if (matches(path, sharedInputs)) {
      complete = true;
      select(heavyJobs, path);
      continue;
    }
    if (matches(path, staticInputs)) continue;
    const affected = areas.filter((area) => matches(path, area.paths));
    // Area heuristics cannot establish that every dependent scenario is declared.
    const covered = frozenInput(path) && declared.some((entry) => entry.jobs.length);
    if (!covered) complete = true;
    select(covered ? affected.flatMap((area) => area.jobs) : heavyJobs, path);
  }
  return {
    declaredFiles: complete ? null : [...declaredFiles].sort(),
    jobs: heavyJobs.filter((job) => reasons.has(job)),
    reasons: Object.fromEntries([...reasons].map(([job, paths]) => [job, [...paths]])),
  };
}

export function jobRoutes(jobs: readonly string[], configuredBoatJobs: string) {
  const configured = parseBoatJobs(configuredBoatJobs);
  return {
    hostedJobs: jobs.filter((job) => !configured.includes(job)),
    boatJobs: jobs.filter((job) => configured.includes(job)),
  };
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
  if (result.status !== 0) throw new Error("Could not read the changed carry");
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
