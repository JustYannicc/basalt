import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
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

// Effect's language service runs inside the type checker. tsconfig.effect.json raises these rules
// to errors and keeps them out of the compiler's exit code; this gate then holds Basalt's own code
// to a shrink-only count per rule and file. The pinned compiler knows only these rule names, so
// newer upstream rules (effectTryWithoutCatch and the 0.63/0.64 pipeline rewrites) need a bump.
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

// A rise fails; a fall fails until the baseline is lowered. Entries for deleted files are ignored.
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

// The committed baseline never grows against the base commit: no file the base had may gain a
// count, and no rule's total may rise. New files only take over counts moved out of others.
export function baseProblems(head: Counts, base: Counts, baseFiles: ReadonlySet<string>) {
  const problems: string[] = [];
  for (const rule of rulesOf(head, base)) {
    const now = head[rule] ?? {};
    const before = base[rule] ?? {};
    for (const [file, count] of Object.entries(now))
      if (baseFiles.has(file) && count > (before[file] ?? 0))
        problems.push(
          `${baselinePath} raises ${file} ${rule} from ${before[file] ?? 0} to ${count} over the base commit.`,
        );
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
  const committed = git("show", `${base}:${baselinePath}`);
  if (committed.status !== 0) {
    console.log(`The base commit ${base} has no ${baselinePath}; nothing to compare it with.`);
    return [];
  }
  const files = git("ls-tree", "-r", "--name-only", base, "--", "scripts", "src");
  if (files.status !== 0) return [`git ls-tree ${base} failed: ${files.stderr.trim()}`];
  return baseProblems(head, JSON.parse(committed.stdout), new Set(files.stdout.split("\n")));
}

function check() {
  const record = readRecord();
  const baseline: Counts = JSON.parse(readFileSync(join(root, baselinePath), "utf8"));
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
  const typecheck = spawnSync(process.execPath, ["scripts/typecheck.ts"], {
    cwd: root,
    stdio: "inherit",
  });
  if (typecheck.status !== 0)
    throw new Error(`node scripts/typecheck.ts failed with exit ${typecheck.status}`);
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
    process.stderr.write(`Effect diagnostics gate failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
