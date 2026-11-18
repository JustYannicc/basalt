import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.ts";
import {
  configPath,
  inheritingConfigs,
  notTypeChecked,
  pluginConfigs,
  readRecord,
  render,
  root,
  scopeFiles,
  suppressionComment,
  type Counts,
  type Diagnostic,
} from "./effect-diagnostics-record.ts";

// Raised to errors in tsconfig.effect.json and held to the baseline. Names the pinned compiler
// does not know fail the gate as unknownRuleName, so newer upstream rules wait for a compiler bump.
export const gatedRules = [
  "acquireReleaseDisposable",
  "allOfMapToForEach",
  "anyUnknownInErrorContext",
  "catchAllTagDispatchToCatchTag",
  "catchAllToMapError",
  "catchChainToFirstSuccessOf",
  "catchConditionalRefailToCatchIf",
  "catchDieToOrDie",
  "catchIfTagToCatchTag",
  "catchRefailToTapError",
  "catchTagToCatchReason",
  "catchToIgnore",
  "catchToOrElseSucceed",
  "catchUnfailableEffect",
  "classSelfMismatch",
  "effectFnIife",
  "effectFnImplicitAny",
  "effectGenUsesAdapter",
  "effectInFailure",
  "effectInVoidSuccess",
  "effectMapFlatten",
  "effectMapVoid",
  "effectSucceedWithVoid",
  "flatMapConditionalToFilterOrFail",
  "flatMapIgnoredParamToAndThen",
  "flatMapToMap",
  "floatingEffect",
  "floatingEffectInVitest",
  "genericEffectServices",
  "globalConsoleInEffect",
  "globalErrorInEffectCatch",
  "globalErrorInEffectFailure",
  "globalFetchInEffect",
  "layerMergeAllWithDependencies",
  "lazyPromiseInEffectSync",
  "leakingRequirements",
  "mapSomeToAsSome",
  "matchEffectToMapBoth",
  "matchEffectToMatch",
  "missingEffectContext",
  "missingEffectError",
  "missingLayerContext",
  "missingReturnYieldStar",
  "missingStarInYieldEffectGen",
  "multipleCatchTag",
  "nonObjectEffectServiceType",
  "obsoleteMatchImport",
  "obsoleteSchemaImport",
  "optionMatchToFromOption",
  "outdatedApi",
  "overriddenSchemaConstructor",
  "preferSucceedSomeOrNone",
  "promiseInEffectSuccess",
  "raceFirstWithSleepToTimeout",
  "redundantMapError",
  "redundantOrDie",
  "returnEffectInGen",
  "runEffectInsideEffect",
  "runOfExitToRunExit",
  "schemaLiteralNonFinite",
  "schemaOpaqueInstanceMember",
  "schemaSync",
  "schemaSyncInEffect",
  "scopeInLayerEffect",
  "syncToSucceed",
  "timeoutCatchTagToTimeoutOrElse",
  "tryCatchInEffectGen",
  "unknownInEffectCatch",
  "unnecessaryEffectGen",
  "unnecessaryFailYieldableError",
  "unnecessaryPipe",
  "unnecessaryPipeChain",
  "unsafeEffectTypeAssertion",
] as const;

// The other rules the pinned compiler enables by default are style or effect-native hints the
// gate does not hold; they are off so the type check does not pay for them.
export const quietRules = [
  "abortControllerInEffect",
  "duplicatePackage",
  "effectFnOpportunity",
  "lazyEffect",
  "multipleEffectProvide",
  "preferTypedSchemaDecoder",
  "preferUnsafeConstructor",
  "provideLayerSucceedToProvideService",
  "redundantSchemaTagIdentifier",
  "schemaNumber",
  "schemaStructWithTag",
  "unnecessaryTypeofType",
] as const;

// Program files outside the gate's scope, where every rule is off for the same reason.
export const quietPaths = [
  ".upstream/**/*",
  "**/node_modules/**/*",
  "apps/**/*",
  "clients/**/*",
  "e2e/**/*",
  "scripts/release-barrier/**/*",
  "*.ts",
] as const;

export const baselinePath = "scripts/effect-diagnostics.baseline.json";
export const writeCommand = "node scripts/effect-diagnostics.ts --write";

export function pluginConfig() {
  const off = Object.fromEntries([...gatedRules, ...quietRules].map((rule) => [rule, "off"]));
  const plugin = {
    name: "@effect/language-service",
    includeSuggestionsInTsc: false,
    ignoreEffectWarningsInTscExitCode: true,
    ignoreEffectErrorsInTscExitCode: true,
    diagnosticSeverity: {
      ...Object.fromEntries(quietRules.map((rule) => [rule, "off"])),
      ...Object.fromEntries(gatedRules.map((rule) => [rule, "error"])),
    },
    overrides: [{ include: quietPaths, options: { diagnosticSeverity: off } }],
  };
  return JSON.stringify({ compilerOptions: { plugins: [plugin] } }, null, 2) + "\n";
}

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
          `${file}: ${rule} rose from ${limit} to ${found}. ` +
            (rule === notTypeChecked
              ? "No program in scripts/typecheck.ts reads this file; include it in one."
              : rule === suppressionComment
                ? "Remove the ts-nocheck or effect-diagnostics comment; it hides diagnostics."
                : "Fix the new sites:\n" + sites.map((d) => "  " + render(d)).join("\n")),
        );
      } else if (found < limit && exists(file))
        problems.push(
          `${file}: ${rule} fell from ${limit} to ${found}. Lower the baseline with ${writeCommand}.`,
        );
    }
  }
  return problems;
}

// The committed baseline never grows against the base commit. A new path may only carry what
// git's rename or copy sources for it lost, so moved code keeps its counts and new code has none.
export function baseProblems(
  head: Counts,
  base: Counts,
  baseFiles: ReadonlySet<string>,
  sources: ReadonlyMap<string, readonly string[]> = new Map(),
) {
  const problems: string[] = [];
  for (const rule of rulesOf(head, base)) {
    const now = head[rule] ?? {};
    const before = base[rule] ?? {};
    for (const [file, count] of Object.entries(now)) {
      const moved = (sources.get(file) ?? []).reduce(
        (sum, source) => sum + Math.max(0, (before[source] ?? 0) - (now[source] ?? 0)),
        0,
      );
      const allowed = baseFiles.has(file) ? (before[file] ?? 0) : moved;
      if (count > allowed)
        problems.push(
          `${baselinePath} raises ${file} ${rule} from ${allowed} to ${count} over the base commit.`,
        );
    }
    if (total(now) > total(before))
      problems.push(
        `${baselinePath} raises the ${rule} total from ${total(before)} to ${total(now)} over the base commit.`,
      );
  }
  return problems;
}

function configProblems() {
  const problems: string[] = [];
  const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
  if (readFileSync(join(root, configPath), "utf8") !== pluginConfig())
    problems.push(
      `${configPath} differs from the gated rules in scripts/effect-diagnostics.ts. Regenerate it with ${writeCommand}.`,
    );
  const scope = scopeFiles();
  for (const glob of quietPaths) {
    const silenced = scope.filter((file) => matchesGlob(file, glob));
    if (silenced.length)
      problems.push(
        `quietPaths ${glob} silences ${silenced.length} in-scope files, such as ${silenced[0]}.`,
      );
  }
  for (const file of pluginConfigs)
    if (read(file).extends !== `./${configPath}`)
      problems.push(`${file} must extend ./${configPath}.`);
  for (const file of [...pluginConfigs, ...inheritingConfigs])
    if (existsSync(join(root, file)) && read(file).compilerOptions?.plugins !== undefined)
      problems.push(
        `${file} sets compilerOptions.plugins, which replaces the Effect diagnostics. Keep them in ${configPath}.`,
      );
  return problems;
}

function baseCommitProblems(head: Counts) {
  const base = process.env.BASE_SHA;
  if (!base) return [];
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).status !== 0)
    return [`BASE_SHA ${base} is not a commit in this checkout.`];
  const files = git("ls-tree", "-r", "--name-only", base, "--", "scripts", "src");
  if (files.status !== 0) return [`git ls-tree ${base} failed: ${files.stderr.trim()}`];
  const baseFiles = new Set(files.stdout.split("\n"));
  if (!baseFiles.has(baselinePath)) {
    console.log(`The base commit ${base} has no ${baselinePath}; nothing to compare it with.`);
    return [];
  }
  const committed = git("show", `${base}:${baselinePath}`);
  if (committed.status !== 0)
    return [`git show ${base}:${baselinePath} failed: ${committed.stderr.trim()}`];
  const diff = git("diff", "-z", "--name-status", "-M30%", "-C30%", base, "--", "scripts", "src");
  if (diff.status !== 0) return [`git diff ${base} failed: ${diff.stderr.trim()}`];
  const sources = new Map<string, string[]>();
  const fields = diff.stdout.split("\0");
  for (let index = 0; index < fields.length; index++)
    if (/^[RC]\d*$/.test(fields[index]!)) {
      const [source, target] = [fields[index + 1]!, fields[index + 2]!];
      sources.set(target, [...(sources.get(target) ?? []), source]);
      index += 2;
    } else index += 1;
  return baseProblems(
    head,
    readCounts(committed.stdout, `${base}:${baselinePath}`),
    baseFiles,
    sources,
  );
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
    ...baseCommitProblems(baseline),
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
