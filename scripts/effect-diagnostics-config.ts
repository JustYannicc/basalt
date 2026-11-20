import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import {
  configPath,
  inheritingConfigs,
  pluginConfigs,
  root,
  scopeFiles,
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

// What each inheriting config extends; pointing one elsewhere could drop the plugin.
const parents: Record<(typeof inheritingConfigs)[number], string> = {
  "tsconfig.stack.json": "./tsconfig.json",
  "tsconfig.obsidian.json": "./tsconfig.pool.json",
  "tsconfig.recipes.json": "./tsconfig.pool.json",
};
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

const pluginKeys = new Set([
  "name",
  "includeSuggestionsInTsc",
  "ignoreEffectWarningsInTscExitCode",
  "ignoreEffectErrorsInTscExitCode",
  "diagnosticSeverity",
  "overrides",
]);

// What a tsconfig.effect.json actually enforces, read from the file rather than from this module:
// the rules at error, and every path any override touches, whatever it sets there.
export function effectPolicy(text: string, source: string) {
  let config: { compilerOptions?: { plugins?: unknown } };
  try {
    config = JSON.parse(text);
  } catch {
    return {
      gated: new Set<string>(),
      quiet: new Set<string>(),
      problems: [`${source} is not JSON.`],
    };
  }
  const plugins = config.compilerOptions?.plugins;
  const plugin = Array.isArray(plugins) && plugins.length === 1 ? plugins[0] : undefined;
  const problems: string[] = [];
  if (plugin?.name !== "@effect/language-service")
    problems.push(`${source} must hold exactly one plugin, @effect/language-service.`);
  for (const key of Object.keys(plugin ?? {}))
    if (!pluginKeys.has(key))
      problems.push(`${source} sets ${key}, which the gate does not allow.`);
  const gated = new Set(
    Object.entries(plugin?.diagnosticSeverity ?? {}).flatMap(([rule, level]) =>
      level === "error" ? [rule] : [],
    ),
  );
  // The compiler applies an override without include, or with exclude or files, to every file,
  // so only the one shape this module generates is accepted.
  const overrides: unknown[] = Array.isArray(plugin?.overrides) ? plugin.overrides : [];
  const quiet = new Set<string>();
  for (const entry of overrides) {
    const include = isObject(entry) ? entry.include : undefined;
    const options = isObject(entry) ? entry.options : undefined;
    const severities = isObject(options) ? options.diagnosticSeverity : undefined;
    const valid =
      isObject(entry) &&
      Object.keys(entry).sort().join() === "include,options" &&
      Array.isArray(include) &&
      include.length > 0 &&
      include.every((glob) => typeof glob === "string" && glob.length > 0) &&
      isObject(options) &&
      Object.keys(options).join() === "diagnosticSeverity" &&
      isObject(severities) &&
      Object.values(severities).every((level) => level === "off");
    if (!valid)
      problems.push(
        `${source} has an override other than {include, options: {diagnosticSeverity: off}}.`,
      );
    if (Array.isArray(include)) for (const glob of include) quiet.add(String(glob));
  }
  return { gated, quiet, problems };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Everything in the file except the rule severities, which may only tighten.
const shape = (text: string) => {
  const config = JSON.parse(text);
  for (const plugin of config?.compilerOptions?.plugins ?? []) {
    delete plugin.diagnosticSeverity;
    for (const entry of plugin.overrides ?? []) delete entry?.options?.diagnosticSeverity;
  }
  return JSON.stringify(config);
};

const readConfig = (file: string) => {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch {
    throw new Error(`${file} is not plain JSON, which the gate needs to read it.`);
  }
};

export function configProblems() {
  const text = readFileSync(join(root, configPath), "utf8");
  const policy = effectPolicy(text, configPath);
  const problems = [...policy.problems];
  if (text !== pluginConfig())
    problems.push(
      `${configPath} differs from the gated rules in scripts/effect-diagnostics-config.ts. Regenerate it with ${writeCommand}.`,
    );
  for (const rule of gatedRules)
    if (!policy.gated.has(rule)) problems.push(`${configPath} does not raise ${rule} to error.`);
  const scope = scopeFiles();
  for (const glob of policy.quiet) {
    // The compiler also honours forms matchesGlob does not read, such as ./dir, /dir or dir/.
    if (glob !== "*.ts" && (!glob.endsWith("/**/*") || /^(?:\.\.?\/|\/)/.test(glob)))
      problems.push(`quiet path ${glob} must be *.ts or a dir/**/* glob without ./, ../ or /.`);
    const silenced = scope.filter((file) => matchesGlob(file, glob));
    if (silenced.length)
      problems.push(
        `quiet path ${glob} silences ${silenced.length} in-scope files, such as ${silenced[0]}.`,
      );
  }
  for (const file of pluginConfigs)
    if (readConfig(file).extends !== `./${configPath}`)
      problems.push(`${file} must extend ./${configPath}.`);
  for (const file of inheritingConfigs)
    if (readConfig(file).extends !== parents[file])
      problems.push(`${file} must extend ${parents[file]}.`);
  return problems;
}

// The gate only tightens: against the base commit the file may only raise more rules to error.
// Any other change, to options, plugins or overrides, fails, whatever this module allows.
// Rules the base did not gate are returned as adopted, so their counts start fresh.
export function freezeProblems(baseText: string, source: string) {
  const headText = readFileSync(join(root, configPath), "utf8");
  const base = effectPolicy(baseText, source);
  const head = effectPolicy(headText, configPath);
  let reshaped = true;
  try {
    reshaped = shape(baseText) !== shape(headText);
  } catch {
    reshaped = true;
  }
  const problems = [
    ...(reshaped
      ? [`${configPath} changes more than its rule severities over the base commit.`]
      : []),
    ...[...base.gated]
      .filter((rule) => !head.gated.has(rule))
      .map((rule) => `${configPath} stops gating ${rule}, which the base commit gates.`),
  ];
  const adopted = new Set([...head.gated].filter((rule) => !base.gated.has(rule)));
  return { problems: base.problems.length ? [...base.problems, ...problems] : problems, adopted };
}
