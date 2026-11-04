import { execFileSync, spawnSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { areas, heavyJobs, sharedInputs, staticInputs } from "./areas.ts";
import { isEligibleJob } from "../ci-bundles/schedule.ts";

const matches = (file: string, patterns: readonly string[]) =>
  patterns.some((pattern) => matchesGlob(file, pattern));
const validPath = (file: string) =>
  file.length > 0 &&
  !file.startsWith("/") &&
  !file.split("/").some((part) => part === ".." || part === ".");

export function selectPaths(paths: readonly string[]) {
  const reasons = new Map<string, Set<string>>();
  const select = (jobs: readonly string[], path: string) => {
    for (const job of jobs) {
      if (!heavyJobs.includes(job)) throw new Error("Unknown CI job in area declaration");
      const previous = reasons.get(job) ?? new Set<string>();
      previous.add(path);
      reasons.set(job, previous);
    }
  };
  for (const path of [...new Set(paths)].sort()) {
    if (!validPath(path)) throw new Error("Changed path escapes the repository");
    if (matches(path, sharedInputs)) {
      select(heavyJobs, path);
      continue;
    }
    if (matches(path, staticInputs)) continue;
    const affected = areas.filter((area) => matches(path, area.paths));
    // A broad build input alone does not establish which product scenarios cover a runtime change.
    const covered = affected.some((area) => area.jobs.some((job) => job !== "production-build"));
    select(covered ? affected.flatMap((area) => area.jobs) : heavyJobs, path);
  }
  return {
    jobs: heavyJobs.filter((job) => reasons.has(job)),
    reasons: Object.fromEntries([...reasons].map(([job, paths]) => [job, [...paths]])),
  };
}

export function jobRoutes(jobs: readonly string[], configuredBoatJobs: string) {
  const configured = [...new Set(configuredBoatJobs.toLowerCase().split(",").filter(Boolean))];
  if (configured.some((job) => !heavyJobs.includes(job) || !isEligibleJob(job)))
    throw new Error("Unknown configured Boat job");
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

export function carryTargets(patch: string) {
  const diffs = patch.split("\n").filter((line) => line.startsWith("diff --git "));
  if (!diffs.length) {
    const headers = [
      ...patch.matchAll(/^--- (a\/[^\n]+|\/dev\/null)\n\+\+\+ (b\/[^\n]+|\/dev\/null)$/gm),
    ];
    if (!headers.length) throw new Error("Changed carry has no target files");
    return headers.flatMap(([, before, after]) => {
      const targets = [before!, after!]
        .filter((path) => path !== "/dev/null")
        .map((path) => path.slice(2));
      if (!targets.length || targets.some((path) => !validPath(path) || /\s/.test(path)))
        throw new Error("Unsupported carry target path");
      return [...new Set(targets)].map((target) => ".upstream/" + target);
    });
  }
  return diffs.flatMap((line) => {
    const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (!match || !validPath(match[1]!) || !validPath(match[2]!))
      throw new Error("Unsupported carry target path");
    return [...new Set([match[1]!, match[2]!])].map((target) => ".upstream/" + target);
  });
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
