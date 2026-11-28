import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { importGraph, isCode } from "../ci/import-graph.ts";
import { jobEntries, readWorkflow } from "../ci/job-inputs.ts";
import { onReleasePath, releaseCuts, releasePaths, upstreamReleasePaths } from "./release-path.ts";

/**
 * The scripts a release-path workflow's jobs run: what each step starts, through package scripts
 * and local actions too, read the way CI's own selection reads it (`jobEntries`). So a new entry
 * is covered the day it appears.
 */
export function releaseEntries(root: string, files: readonly string[], paths = releasePaths) {
  const entries = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(".github/workflows/") || !onReleasePath(file, paths)) continue;
    let jobs: ReturnType<typeof jobEntries>;
    try {
      jobs = jobEntries(root, readWorkflow(root, file), files);
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
    // The tests a release runs are gates of it, so they count as entries too.
    for (const named of Object.values(jobs))
      for (const entry of named) if (isCode(entry)) entries.add(entry);
  }
  return entries;
}

/** The files a carry's patch changes in the prepared upstream tree, by its git headers. */
export const patchTargets = (patch: string) => [
  ...new Set(
    [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)].flatMap((m) => [m[1]!, m[2]!]),
  ),
];

/**
 * What a production release runs or reads: the entries and everything they import or name,
 * transitively, stopping at the cuts. Each file keeps the file that first reached it, so a failure
 * can show the chain. Prepared upstream files are reported apart: they change only through carries.
 */
export function releaseClosure(root: string, cuts = releaseCuts.map(({ path }) => path)) {
  const graph = importGraph(root);
  const imports = new Map<string, Set<string>>();
  for (const [target, importers] of graph.importers)
    for (const importer of importers) {
      if (!imports.has(importer)) imports.set(importer, new Set());
      imports.get(importer)!.add(target);
    }
  const isCut = (file: string) => cuts.some((pattern) => matchesGlob(file, pattern));
  const entries = [...releaseEntries(root, [...graph.files])].filter((file) =>
    graph.files.has(file),
  );
  const parent = new Map<string, string | undefined>(entries.map((file) => [file, undefined]));
  const pending = [...entries];
  const cutsReached = new Set<string>();
  while (pending.length) {
    const file = pending.shift()!;
    if (isCut(file)) {
      cutsReached.add(file);
      continue;
    }
    for (const next of imports.get(file) ?? [])
      if (!parent.has(next)) {
        parent.set(next, file);
        pending.push(next);
      }
  }
  const reached = [...parent.keys()];
  const chain = (file: string) => {
    const steps = [file];
    for (let at = parent.get(file); at !== undefined; at = parent.get(at)) steps.unshift(at);
    return steps;
  };
  return {
    entries: entries.sort(),
    files: reached.filter((file) => graph.files.has(file) && !isCut(file)).sort(),
    cuts: [...cutsReached].sort(),
    upstream: reached.filter((file) => file.startsWith(".upstream/") && !isCut(file)).sort(),
    tracked: graph.files,
    imports,
    chain,
  };
}

/**
 * The carries a release depends on: those whose patch changes an upstream file the release
 * reaches, one of the upstream stack's own files (`upstreamPaths`; the walk stops at `.upstream`,
 * so files the stack reaches inside it are named there), or the deploy library's own patch.
 */
export function carriesReaching(
  root: string,
  upstream: readonly string[],
  files: Iterable<string>,
  upstreamPaths: readonly string[] = upstreamReleasePaths,
) {
  const reached = new Set(upstream.map((file) => file.slice(".upstream/".length)));
  const counts = (target: string) =>
    reached.has(target) ||
    /^patches\/alchemy@[^/]+\.patch$/u.test(target) ||
    upstreamPaths.some((pattern) => matchesGlob(target, pattern));
  const carries: { carry: string; targets: string[] }[] = [];
  for (const file of files) {
    if (!/^patches\/[^/]+\.patch$/u.test(file)) continue;
    const targets = patchTargets(readFileSync(join(root, file), "utf8")).filter(counts);
    if (targets.length) carries.push({ carry: file, targets });
  }
  return carries.sort((a, b) => a.carry.localeCompare(b.carry));
}
