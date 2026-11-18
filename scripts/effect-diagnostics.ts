import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.ts";
import {
  canaryPath,
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

export interface BaseInputs {
  baseFiles: ReadonlySet<string>;
  headFiles: ReadonlySet<string>;
  // Line text the change removed, per file: a site whose line matches one moved with its code.
  removed?: ReadonlyMap<string, readonly string[]>;
  // Whole-file counts have no site line, so they follow git renames instead.
  renamed?: ReadonlyMap<string, string>;
  adopted?: ReadonlySet<string>;
  diagnostics?: readonly Diagnostic[];
  lineText?: (file: string, line: number) => string;
}

const wholeFile = new Set([notTypeChecked, effectInJavaScript]);

// The committed baseline never grows against the base commit. A site may only move: a rise in a
// file is paid for by a site whose line text the change removed from a file that lost a count of
// the same rule, each removed line once. Rules the base did not gate start fresh; entries for
// files neither side has are ignored.
export function baseProblems(head: Counts, base: Counts, inputs: BaseInputs) {
  const { baseFiles, headFiles, removed = new Map(), renamed = new Map() } = inputs;
  const { adopted = new Set(), diagnostics = [], lineText = () => "" } = inputs;
  const problems: string[] = [];
  const present = (counts: Record<string, number>, files: ReadonlySet<string>) =>
    Object.fromEntries(Object.entries(counts).filter(([file]) => files.has(file)));
  for (const rule of rulesOf(head, base)) {
    if (adopted.has(rule)) continue;
    const now = present(head[rule] ?? {}, headFiles);
    const before = present(base[rule] ?? {}, baseFiles);
    const lost: Record<string, number> = Object.fromEntries(
      Object.entries(before).map(([file, count]) => [file, Math.max(0, count - (now[file] ?? 0))]),
    );
    const pool = new Map(
      Object.keys(lost)
        .filter((file) => lost[file]! > 0)
        .map((file) => [file, [...(removed.get(file) ?? [])]]),
    );
    for (const [file, count] of Object.entries(now).sort()) {
      let allowed = baseFiles.has(file) ? (before[file] ?? 0) : 0;
      const sites = diagnostics.filter((d) => d.file === file && d.rule === rule);
      if (count > allowed && wholeFile.has(rule)) {
        const old = renamed.get(file);
        const take = old ? Math.min(lost[old] ?? 0, count - allowed) : 0;
        allowed += take;
        if (old) lost[old] = (lost[old] ?? 0) - take;
      } else
        for (const site of sites) {
          if (allowed >= count) break;
          const text = lineText(file, site.line).trim();
          if (text.length < 8) continue;
          for (const [source, lines] of pool) {
            const at = source === file || lost[source]! <= 0 ? -1 : lines.indexOf(text);
            if (at < 0) continue;
            lines.splice(at, 1);
            lost[source]! -= 1;
            allowed += 1;
            break;
          }
        }
      if (count > allowed)
        problems.push(
          `${baselinePath} raises ${file} ${rule} from ${allowed} to ${count} over the base commit.` +
            sites.map((d) => "\n  " + render(d)).join(""),
        );
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

function removedLines(diff: string) {
  const removed = new Map<string, string[]>();
  let file: string | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) [file, inHunk] = [undefined, false];
    else if (!inHunk) {
      if (line.startsWith("--- a/")) file = line.slice(6);
      else if (line.startsWith("@@")) inHunk = true;
    } else if (line.startsWith("-") && file)
      removed.set(file, [...(removed.get(file) ?? []), line.slice(1).trim()]);
  }
  return removed;
}

function baseCommitProblems(head: Counts, diagnostics: readonly Diagnostic[]) {
  const base = process.env.BASE_SHA;
  if (!base) return [];
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  if (git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).status !== 0)
    return [`BASE_SHA ${base} is not a commit in this checkout.`];
  const output = (...args: string[]) => {
    const result = git(...args);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const baseFiles = new Set(
    output("ls-tree", "-r", "-z", "--name-only", base, "--", "scripts", "src", configPath).split(
      "\0",
    ),
  );
  if (!baseFiles.has(baselinePath)) {
    console.log(`The base commit ${base} has no ${baselinePath}; nothing to compare it with.`);
    return [];
  }
  const freeze = freezeProblems(output("show", `${base}:${configPath}`), `${base}:${configPath}`);
  const renamed = new Map<string, string>();
  const fields = output("diff", "-z", "--name-status", "-M", base, "--", "scripts", "src").split(
    "\0",
  );
  for (let index = 0; index < fields.length; index++)
    if (/^R\d*$/.test(fields[index]!)) {
      renamed.set(fields[index + 2]!, fields[index + 1]!);
      index += 2;
    } else index += 1;
  const removed = removedLines(
    output("diff", "-U0", "--no-renames", "--no-color", base, "--", "scripts", "src"),
  );
  const lines = new Map<string, string[]>();
  const lineText = (file: string, line: number) => {
    if (!lines.has(file)) lines.set(file, readFileSync(join(root, file), "utf8").split("\n"));
    return lines.get(file)![line - 1] ?? "";
  };
  const headFiles = new Set(
    Object.values(head)
      .flatMap((files) => Object.keys(files))
      .filter((file) => existsSync(join(root, file))),
  );
  return [
    ...freeze.problems,
    ...baseProblems(
      head,
      readCounts(output("show", `${base}:${baselinePath}`), `${base}:${baselinePath}`),
      {
        baseFiles,
        headFiles,
        removed,
        renamed,
        adopted: freeze.adopted,
        diagnostics,
        lineText,
      },
    ),
  ];
}

// The canary's sites are fixed; a different report means something silenced or changed the rules.
const canaryReport = {
  anyUnknownInErrorContext: 2,
  floatingEffect: 1,
  globalErrorInEffectFailure: 1,
  schemaSync: 1,
  unknownInEffectCatch: 1,
};
const canaryProblems = (canary: Record<string, number>) => {
  const expected = JSON.stringify(canaryReport);
  const found = JSON.stringify(Object.fromEntries(Object.entries(canary).sort()));
  return found === expected
    ? []
    : [
        `${canaryPath} reports ${found} instead of ${expected}; something silences Effect's diagnostics.`,
      ];
};

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
    ...canaryProblems(record.canary),
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
  const record = readRecord();
  const broken = [
    ...canaryProblems(record.canary),
    ...record.misconfigured.map(
      (d) => `The Effect plugin rejected its configuration: ${render(d)}`,
    ),
  ];
  if (broken.length) throw new Error(`no baseline written: ${broken.join(" ")}`);
  const counts = sorted(record.counts);
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
