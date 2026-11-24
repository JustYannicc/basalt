import { execFileSync } from "node:child_process";
import { areas, heavyJobs, runtimeReads } from "./areas.ts";
import { readDeclarations } from "./declarations.ts";
import { fastJobs } from "./gate.ts";
import { dependents, importGraph, isTest, trackedFiles } from "./import-graph.ts";
import { addTo, carriedReferences, fileMatcher, upstreamInputFiles } from "./inputs.ts";
import { jobEntries, readWorkflow } from "./job-inputs.ts";

// The jobs that decide which jobs run, the fast jobs and the aggregate run in every Check, so a
// file the affected lane runs in them is proven there. The lane's fast job runs the owned unit
// tests a change reaches (scripts/ci/unit-tests.ts).
const always = [...fastJobs, "reuse", "check"];
export const ownedUnitSuite = { jobs: { owned: { steps: [{ run: "npm run check" }] } } };

/**
 * Which jobs each repository file is an input of. A heavy job's inputs are the files its steps
 * name, the files its areas declare, and the declared inputs of the scenarios it runs, including
 * the repository files their carried helpers name. A file only the jobs of every Check run, such
 * as selection, is proven there; a selection it gets wrong still runs in the batch Check, which
 * runs every heavy job. The import graph carries the declared runtime reads and the files carried
 * product code names, which every job that prepares the product builds.
 */
function buildReach(root: string) {
  const files = trackedFiles(root);
  // The import graph, plus the declared runtime reads and the files carried code names.
  const graph = importGraph(root, files);
  const link = (importer: string, target: string) => addTo(graph.importers, target, importer);
  const matching = fileMatcher(files);
  for (const { reader, paths } of runtimeReads) {
    const read = paths.flatMap(matching);
    if (!graph.files.has(reader) || !read.length)
      throw new Error("Stale runtime read declaration: " + reader);
    for (const file of read) link(reader, file);
  }
  const carried = carriedReferences(root, files);
  const pinned = new Set(upstreamInputFiles(root).map((file) => ".upstream/" + file));
  for (const [target, named] of carried)
    // Product code, and e2e helpers upstream's own tests may import: whoever runs the prepared
    // product or harness may run what they name. A carried spec's jobs are its declared ones.
    if (!target.startsWith(".upstream/e2e/") || (pinned.has(target) && !isTest(target)))
      for (const file of named)
        if (!file.startsWith(".upstream/")) link("scripts/prepare-upstream.ts", file);
  // What a carried e2e file names, directly or through the carried helpers it names.
  const harness = (target: string) =>
    [...dependents(carried, [target])].filter((file) => !file.startsWith(".upstream/"));
  const entries = jobEntries(root, readWorkflow(root), files);
  const jobs = new Map<string, Set<string>>();
  for (const job of heavyJobs) for (const file of entries[job] ?? []) addTo(jobs, file, job);
  // A test file is an input only of the jobs that run it, never of an area or a scenario.
  const sources = (pattern: string) => matching(pattern).filter((file) => !isTest(file));
  for (const area of areas)
    for (const file of area.paths.flatMap(sources))
      for (const job of area.jobs) addTo(jobs, file, job);
  const declarations = readDeclarations(root);
  const scenarios = new Map<string, Set<string>>();
  for (const [spec, entry] of Object.entries(declarations.files)) {
    for (const input of entry.inputs.filter((input) => !input.startsWith(".upstream/")))
      for (const file of sources(input)) addTo(scenarios, file, spec);
    for (const file of harness(".upstream/e2e/tests/" + spec)) addTo(scenarios, file, spec);
  }
  const lane = jobEntries(root, readWorkflow(root), files, { lane: true });
  const fast = new Set([
    ...always.flatMap((job) => [...(lane[job] ?? [])]),
    ...jobEntries(root, ownedUnitSuite, files).owned!,
  ]);
  return { graph, jobs, scenarios, fast, declarations, entries };
}
export type Reach = ReturnType<typeof buildReach>;

const built = new Map<string, Reach>();

/** Built once per checkout and commit: selection and its tests read the same tree many times. */
export function reach(root: string) {
  const head = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const key = JSON.stringify([root, head]);
  if (!built.has(key)) built.set(key, buildReach(root));
  return built.get(key)!;
}
