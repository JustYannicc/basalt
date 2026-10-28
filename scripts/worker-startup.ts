/**
 * Gate every built Worker's startup CPU and upload size before a deploy can be rejected for them.
 *
 * Cloudflare rejects an upload whose global scope takes too long to start (`Script startup exceeded
 * CPU time limit`, code 10021) and any Worker over its size limit:
 * https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time
 * https://developers.cloudflare.com/workers/platform/limits/#worker-size
 * This profiles the exact modules `npm run build` produced the way Wrangler's documented startup
 * profiler (`wrangler check startup`) does, in workerd on this machine. Local CPU is not
 * Cloudflare's, so the budgets keep a wide margin and use the median of several runs.
 *
 *   node scripts/worker-startup.ts [--runs 5] [--profiles <directory>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { activeMs, loadMiniflare, profileStartup, sampled, type CpuProfile } from "./startup-profiler/profile.ts";

/** Cloudflare's startup limit: the global scope must parse and execute within one second. */
export const startupLimitMs = 1_000;
/** A budget well under it: CI runners and Cloudflare's machines differ, and startup varies run to run. */
export const startupBudgetMs = 300;
/** Cloudflare's size limit, uncompressed; there is no compressed limit. */
export const sizeLimitBytes = 64 * 1024 * 1024;
/** Fail at half of it. Upstream's own per-Worker upload budgets are far tighter. */
export const sizeBudgetBytes = sizeLimitBytes / 2;
/** The deployments' compatibility settings; they select the runtime behavior modules start under. */
const compatibility = { date: "2026-09-08", flags: ["nodejs_compat"] };
/** Workers whose rejection blocked a production deploy; the check fails if any is missing. */
export const requiredWorkers = ["Api", "Router"];

/** One built Worker: its upload directory and the module Cloudflare starts. */
export interface WorkerBundle {
  readonly name: string;
  readonly directory: string;
  readonly entry: string;
  readonly modules: ReadonlyArray<string>;
}

export interface Measurement {
  readonly name: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly startupMs: ReadonlyArray<number>;
}

const listFiles = (directory: string, prefix = ""): string[] =>
  readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? listFiles(directory, join(prefix, item.name)) : [join(prefix, item.name)],
  );

/**
 * The Worker's main module. Rolldown names the entry `[name].js` and every other chunk
 * `[name]-[hash].js`, and chunks import the entry back, so the import graph has no single root.
 * A content hash is 8 URL-safe characters with at least one capital or digit.
 */
export const findEntry = (modules: ReadonlyArray<string>) => {
  const entries = modules.filter(
    (file) => /^[^/]+\.js$/.test(file) && !/-(?=[\w-]{0,7}[A-Z0-9])[\w-]{8}\.js$/.test(file),
  );
  if (entries.length !== 1) throw new Error(`Expected one main module, found ${entries.join(", ") || "none"}`);
  return entries[0]!;
};

/**
 * The modules the main module reaches through static and dynamic imports: what the Worker uploads.
 * Build directories keep chunks from earlier builds, which are never uploaded.
 */
export const reachableModules = (
  entry: string,
  files: ReadonlyArray<string>,
  read: (module: string) => string,
) => {
  const present = new Set(files);
  const reached = new Set([entry]);
  const pending = [entry];
  for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
    if (!module.endsWith(".js")) continue;
    for (const [, specifier] of read(module).matchAll(/\b(?:from|import)\s*\(?\s*["'`](\.\.?\/[^"'`]+)["'`]/g)) {
      const target = posix.join(posix.dirname(module), specifier!);
      if (present.has(target) && !reached.has(target)) {
        reached.add(target);
        pending.push(target);
      }
    }
  }
  return [...reached].toSorted();
};

export const readBundle = (name: string, from: string): WorkerBundle => {
  // workerd names modules by absolute path.
  const directory = resolve(from);
  const files = listFiles(directory).filter((file) => !file.endsWith(".map"));
  const entry = findEntry(files);
  const modules = reachableModules(entry, files, (module) => readFileSync(join(directory, module), "utf8"));
  return { name, directory, entry, modules };
};

/** Every Worker bundle the build wrote, keyed by its Alchemy resource ID. */
export const findBundles = (roots: ReadonlyArray<string>) => {
  const bundles = roots
    .filter((root) => existsSync(root))
    .flatMap((root) =>
      readdirSync(root, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => readBundle(item.name, join(root, item.name))),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const duplicate = bundles.find((bundle, index) => bundles[index + 1]?.name === bundle.name);
  if (duplicate) throw new Error(`Two builds wrote a Worker named ${duplicate.name}`);
  return bundles;
};

export const median = (values: ReadonlyArray<number>) => {
  if (!values.length) throw new Error("No startup measurements");
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Every budget a measurement crosses, as messages; empty when it fits. */
export const violations = (measurement: Measurement) => {
  const startup = median(measurement.startupMs);
  return [
    ...(startup > startupBudgetMs
      ? [`${measurement.name} starts in ${startup.toFixed(1)} ms of CPU (median); the budget is ${startupBudgetMs} ms, against Cloudflare's ${startupLimitMs} ms limit`]
      : []),
    ...(measurement.bytes > sizeBudgetBytes
      ? [`${measurement.name} uploads ${measurement.bytes} bytes; the budget is ${sizeBudgetBytes}, against Cloudflare's ${sizeLimitBytes} limit`]
      : []),
  ];
};

/** Measure a Worker over several cold starts; `onProfile` receives each run's CPU profile. */
export const measure = async (
  bundle: WorkerBundle,
  runs: number,
  onProfile: (profile: CpuProfile, run: number) => void = () => undefined,
): Promise<Measurement> => {
  if (!Number.isInteger(runs) || runs < 1) throw new Error("Measure at least one start");
  const contents = new Map(bundle.modules.map((module) => [join(bundle.directory, module), readFileSync(join(bundle.directory, module))]));
  const startupMs: number[] = [];
  let stalls = 0;
  while (startupMs.length < runs) {
    const profile = await profileStartup(bundle.name, join(bundle.directory, bundle.entry), contents, compatibility);
    // A stalled sampler measured nothing; start again, but not forever.
    if (!sampled(profile)) {
      if (++stalls > runs) throw new Error(`V8's sampler stalled on ${stalls} starts of ${bundle.name}`);
      continue;
    }
    onProfile(profile, startupMs.length);
    startupMs.push(activeMs(profile));
  }
  const files = [...contents.values()];
  return {
    name: bundle.name,
    bytes: files.reduce((total, file) => total + file.length, 0),
    gzipBytes: files.reduce((total, file) => total + gzipSync(file, { level: 9 }).length, 0),
    startupMs,
  };
};

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

export const report = (measurements: ReadonlyArray<Measurement>) =>
  [
    `Startup CPU budget ${startupBudgetMs} ms (Cloudflare limit ${startupLimitMs} ms); size budget ${kib(sizeBudgetBytes)} (limit ${kib(sizeLimitBytes)}).`,
    "",
    "| Worker | Uncompressed | Gzip | Startup CPU, median | Runs (ms) |",
    "|---|---:|---:|---:|---|",
    ...measurements.map(
      (m) =>
        `| ${m.name} | ${kib(m.bytes)} | ${kib(m.gzipBytes)} | ${median(m.startupMs).toFixed(1)} ms | ${m.startupMs.map((ms) => ms.toFixed(1)).join(", ")} |`,
    ),
  ].join("\n");

if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const runs = Number(flag("--runs") ?? 5);
  // Each run's profile opens in Chrome DevTools or VS Code, like `wrangler check startup` writes.
  const profiles = flag("--profiles");
  if (profiles) mkdirSync(profiles, { recursive: true });
  loadMiniflare();
  const bundles = findBundles([
    join(root, ".upstream/apps/hosted/cloud/.alchemy/bundles"),
    join(root, ".alchemy/bundles"),
  ]);
  const missing = requiredWorkers.filter((name) => !bundles.some((bundle) => bundle.name === name));
  if (missing.length) throw new Error(`Run npm run build first; missing Worker bundles: ${missing.join(", ")}`);
  const measurements: Measurement[] = [];
  for (const bundle of bundles) {
    console.log(`Profiling ${bundle.name} (${relative(root, join(bundle.directory, bundle.entry))})`);
    measurements.push(
      await measure(bundle, runs, (profile, run) => {
        if (profiles) writeFileSync(join(profiles, `${bundle.name}-${run + 1}.cpuprofile`), JSON.stringify(profile));
      }),
    );
  }
  const table = report(measurements);
  console.log(`\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Worker startup and size\n\n${table}\n`, { flag: "a" });
  const failures = measurements.flatMap(violations);
  for (const failure of failures) console.error(`::error title=Worker startup budget::${failure}`);
  if (failures.length) process.exitCode = 1;
}
