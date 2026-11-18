import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.ts";
import {
  configPath,
  effectInJavaScript,
  notTypeChecked,
  readRecord,
  render,
  root,
  suppressionComment,
  type Counts,
  type Diagnostic,
} from "./effect-diagnostics-record.ts";
import {
  configProblems,
  freezeProblems,
  pluginConfig,
  writeCommand,
} from "./effect-diagnostics-config.ts";

const advice: Record<string, string> = {
  [notTypeChecked]: "No program in scripts/typecheck.ts reads this file; include it in one.",
  [effectInJavaScript]: "No program checks JavaScript; write Effect code in TypeScript.",
  [suppressionComment]: "Remove the tag; it hides diagnostics:",
};

export const baselinePath = "scripts/effect-diagnostics.baseline.json";

const sorted = (counts: Counts): Counts =>
  Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((rule) => [rule, Object.fromEntries(Object.entries(counts[rule]!).sort())] as const),
  );
const total = (files: Record<string, number> = {}) =>
  Object.values(files).reduce((a, b) => a + b, 0);
const rulesOf = (...all: Counts[]) =>
  [...new Set(all.flatMap((counts) => Object.keys(counts)))].sort();

// Entries for deleted files never fail, so deleting code needs no baseline change.
export function baselineProblems(
  current: Counts,
  baseline: Counts,
  exists: (file: string) => boolean,
  diagnostics: readonly Diagnostic[] = [],
) {
  const problems: string[] = [];
  for (const rule of rulesOf(current, baseline)) {
    const now = current[rule] ?? {};
    const allowed = baseline[rule] ?? {};
    for (const file of [...new Set([...Object.keys(now), ...Object.keys(allowed)])].sort()) {
      const found = now[file] ?? 0;
      const limit = allowed[file] ?? 0;
      if (found > limit) {
        const sites = diagnostics.filter((d) => d.file === file && d.rule === rule);
        problems.push(
          `${file}: ${rule} rose from ${limit} to ${found}. ${advice[rule] ?? "Fix the new sites:"}` +
            sites.map((d) => "\n  " + render(d)).join(""),
        );
      } else if (found < limit && exists(file))
        problems.push(
          `${file}: ${rule} fell from ${limit} to ${found}. Lower the baseline with ${writeCommand}.`,
        );
    }
  }
  return problems;
}

// The committed baseline never grows against the base commit. A new path may only carry what its
// git rename or copy sources lost, shared out once, so moved code keeps its counts and new code has
// none. Rules the base did not gate start fresh; entries for files neither side has are ignored.
export function baseProblems(
  head: Counts,
  base: Counts,
  baseFiles: ReadonlySet<string>,
  headFiles: ReadonlySet<string>,
  sources: ReadonlyMap<string, readonly string[]> = new Map(),
  adopted: ReadonlySet<string> = new Set(),
  diagnostics: readonly Diagnostic[] = [],
) {
  const problems: string[] = [];
  const present = (counts: Record<string, number>, files: ReadonlySet<string>) =>
    Object.fromEntries(Object.entries(counts).filter(([file]) => files.has(file)));
  for (const rule of rulesOf(head, base)) {
    if (adopted.has(rule)) continue;
    const now = present(head[rule] ?? {}, headFiles);
    const before = present(base[rule] ?? {}, baseFiles);
    const credit = Object.fromEntries(
      Object.entries(before).map(([file, count]) => [file, Math.max(0, count - (now[file] ?? 0))]),
    );
    for (const [file, count] of Object.entries(now).sort()) {
      let allowed = before[file] ?? 0;
      if (!baseFiles.has(file))
        for (const source of sources.get(file) ?? []) {
          const take = Math.min(credit[source] ?? 0, count - allowed);
          allowed += take;
          credit[source] = (credit[source] ?? 0) - take;
        }
      if (count > allowed) {
        const sites = diagnostics.filter((d) => d.file === file && d.rule === rule);
        problems.push(
          `${baselinePath} raises ${file} ${rule} from ${allowed} to ${count} over the base commit.` +
            sites.map((d) => "\n  " + render(d)).join(""),
        );
      }
    }
    if (total(now) > total(before)) {
      const grown = Object.keys(now).filter((file) => now[file]! > (before[file] ?? 0));
      problems.push(
        `${baselinePath} raises the ${rule} total from ${total(before)} to ${total(now)} over the base commit, in ${grown.join(", ")}.`,
      );
    }
  }
  return problems;
}

function baseCommitProblems(head: Counts, diagnostics: readonly Diagnostic[]) {
  const base = process.env.BASE_SHA;
  if (!base) return [];
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).status !== 0)
    return [`BASE_SHA ${base} is not a commit in this checkout.`];
  const tree = (...args: string[]) => {
    const listed = git("ls-tree", "-r", "-z", "--name-only", ...args);
    if (listed.status !== 0) throw new Error(`git ls-tree failed: ${listed.stderr.trim()}`);
    return new Set(listed.stdout.split("\0"));
  };
  const baseFiles = tree(base, "--", "scripts", "src", configPath);
  if (!baseFiles.has(baselinePath)) {
    console.log(`The base commit ${base} has no ${baselinePath}; nothing to compare it with.`);
    return [];
  }
  const show = (path: string) => {
    const shown = git("show", `${base}:${path}`);
    if (shown.status !== 0)
      throw new Error(`git show ${base}:${path} failed: ${shown.stderr.trim()}`);
    return shown.stdout;
  };
  const freeze = freezeProblems(show(configPath), `${base}:${configPath}`);
  // 20% lets a file split four ways keep its counts; copies only match files the change touched.
  const diff = git("diff", "-z", "--name-status", "-M20%", "-C20%", base, "--", "scripts", "src");
  if (diff.status !== 0) return [`git diff ${base} failed: ${diff.stderr.trim()}`];
  const sources = new Map<string, string[]>();
  const fields = diff.stdout.split("\0");
  for (let index = 0; index < fields.length; index++)
    if (/^[RC]\d*$/.test(fields[index]!)) {
      const [source, target] = [fields[index + 1]!, fields[index + 2]!];
      sources.set(target, [...(sources.get(target) ?? []), source]);
      index += 2;
    } else index += 1;
  const headFiles = new Set(
    Object.values(head)
      .flatMap((files) => Object.keys(files))
      .filter((file) => existsSync(join(root, file))),
  );
  return [
    ...freeze.problems,
    ...baseProblems(
      head,
      readCounts(show(baselinePath), `${base}:${baselinePath}`),
      baseFiles,
      headFiles,
      sources,
      freeze.adopted,
      diagnostics,
    ),
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCounts = (value: unknown): value is Counts =>
  isRecord(value) &&
  Object.values(value).every(
    (files) =>
      isRecord(files) && Object.values(files).every((n) => Number.isInteger(n) && Number(n) > 0),
  );

// A conflicted or hand-edited baseline fails by name instead of comparing strings.
function readCounts(text: string, source: string): Counts {
  let counts: unknown;
  try {
    counts = JSON.parse(text);
  } catch {
    counts = undefined;
  }
  if (!isCounts(counts))
    throw new Error(
      `${source} is not a {rule: {file: count}} baseline. Recreate it with ${writeCommand}.`,
    );
  return counts;
}

function check() {
  const record = readRecord();
  const baseline = readCounts(readFileSync(join(root, baselinePath), "utf8"), baselinePath);
  const problems = [
    ...configProblems(),
    ...record.misconfigured.map(
      (d) => `The Effect plugin rejected its configuration: ${render(d)}`,
    ),
    ...baselineProblems(
      record.counts,
      baseline,
      (file) => existsSync(join(root, file)),
      record.diagnostics,
    ),
    ...baseCommitProblems(baseline, record.diagnostics),
  ];
  const found = rulesOf(record.counts).map((rule) => `${rule} ${total(record.counts[rule])}`);
  if (!problems.length) {
    console.log(`Effect diagnostics match ${baselinePath}: ${found.join(", ") || "none"}.`);
    return;
  }
  const report = `Effect diagnostics gate failed (${problems.length}):\n${problems.map((p) => "- " + p).join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.stderr.write(report);
  process.exitCode = 1;
}

function write() {
  writeFileSync(join(root, configPath), pluginConfig());
  run(process.execPath, ["scripts/typecheck.ts"], root);
  const counts = sorted(readRecord().counts);
  writeFileSync(join(root, baselinePath), JSON.stringify(counts, null, 2) + "\n");
  console.log(
    `Wrote ${baselinePath}: ${rulesOf(counts)
      .map((rule) => `${rule} ${total(counts[rule])}`)
      .join(", ")}.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--write")) write();
    else check();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Effect diagnostics gate failed: ${message}\n`);
    process.exitCode = 1;
  }
}
