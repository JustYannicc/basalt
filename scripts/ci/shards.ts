import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { declaredRuns, readDeclarations } from "./declarations.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));

/** About eight minutes of test per shard keeps setup a small share of each job. */
export const shardSeconds = 480;
/** A file's own bound in run-declared, above the slowest measured file (about 7 minutes). */
export const fileDeadlineMinutes = 8;
/** Checkout, toolchain, prepare:upstream, e2e:prepare and the browser measure about 2.65 minutes; doubled for cold caches. */
const setupMinutes = 5;
/** Used only when no measured pair exists at all. */
const defaultSeconds = 60;

export type DeclaredRun = { group: string; file: string };

export const runKey = (run: DeclaredRun) => run.group + " " + run.file;

/** Measured test seconds per "<group> <file>"; a missing file only costs balance, never coverage. */
export function readDeclaredDurations(root = repository) {
  const path = join(root, "scripts/ci/declared-durations.json");
  if (!existsSync(path)) return {};
  const source: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new Error("Declared durations must be an object");
  for (const [key, value] of Object.entries(source))
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error("Invalid declared duration: " + key);
  return source as Record<string, number>;
}

const median = (values: number[]) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Unknown pairs take their group's median, so a new file never breaks or skews planning much. */
export function estimator(durations: Record<string, number>) {
  const overall = median(Object.values(durations)) ?? defaultSeconds;
  const groups = new Map<string, number>();
  return (run: DeclaredRun) => {
    const known = durations[runKey(run)];
    if (known !== undefined) return known;
    if (!groups.has(run.group))
      groups.set(
        run.group,
        median(
          Object.entries(durations)
            .filter(([key]) => key.startsWith(run.group + " "))
            .map(([, seconds]) => seconds),
        ) ?? overall,
      );
    return groups.get(run.group)!;
  };
}

/** Longest-processing-time bin packing: deterministic for the same pairs and durations. */
export function planShards(
  name: string,
  runs: readonly DeclaredRun[],
  durations: Record<string, number>,
) {
  if (new Set(runs.map(runKey)).size !== runs.length) throw new Error("Duplicate declared run");
  // Each row's list is substituted into the step's shell command as one quoted word.
  if (runs.some((run) => !/^[\w.:-]+$/.test(run.group) || !/^[\w.-]+$/.test(run.file)))
    throw new Error("Declared run names must be plain words");
  const estimate = estimator(durations);
  const sized = runs
    .map((run) => ({ run, seconds: estimate(run) }))
    .sort((a, b) => b.seconds - a.seconds || (runKey(a.run) < runKey(b.run) ? -1 : 1));
  const total = sized.reduce((sum, item) => sum + item.seconds, 0);
  const count = Math.min(runs.length, Math.max(1, Math.ceil(total / shardSeconds)));
  const bins = Array.from({ length: count }, () => ({ runs: [] as DeclaredRun[], seconds: 0 }));
  for (const item of sized) {
    const bin = bins.reduce((best, candidate) =>
      candidate.seconds < best.seconds ? candidate : best,
    );
    bin.runs.push(item.run);
    bin.seconds += item.seconds;
  }
  return bins.map((bin, index) => ({
    shard: name + "-" + (index + 1),
    runs: bin.runs
      .sort((a, b) => (runKey(a) < runKey(b) ? -1 : 1))
      .map(runKey)
      .join(" "),
    // Room for slow setup, slower files and one file that runs to its own deadline.
    timeout: Math.ceil(setupMinutes + (bin.seconds / 60) * 1.5 + fileDeadlineMinutes),
  }));
}

/** The pairs one shard row runs, in order; rejects anything that is not whole pairs. */
export function shardRuns(text: string): DeclaredRun[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length % 2) throw new Error("Expected declared group and file pairs");
  return Array.from({ length: words.length / 2 }, (_, index) => ({
    group: words[index * 2]!,
    file: words[index * 2 + 1]!,
  }));
}

export function planDeclaredShards(
  declarations: ReturnType<typeof readDeclarations>,
  durations: Record<string, number>,
  selected: readonly string[] | null = null,
) {
  return Object.fromEntries(
    Object.entries(declaredRuns(selected, declarations)).map(([job, runs]) => [
      job,
      { include: runs.length ? planShards(job, runs, durations) : [] },
    ]),
  );
}

export function declaredMatrices(selected: readonly string[] | null = null, root = repository) {
  return planDeclaredShards(readDeclarations(root), readDeclaredDurations(root), selected);
}
