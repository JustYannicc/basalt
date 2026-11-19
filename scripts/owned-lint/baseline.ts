// How lint findings compare with the recorded baseline, the allowlist and the base commit.
const regenerate = "npm run lint:owned -- --write-baseline";
// landmines keeps these counts itself, in the rule's options, and reports a stale count.
export const NATIVE_ALLOWLIST = new Set([
  "landmines-testing/no-fixed-sleep",
  "landmines-testing/no-flake-masking",
  "landmines-testing/strict-msw",
  "landmines-testing/no-unsignaled-poll",
]);
// The rules whose message offers an allowlist entry; every other finding is fixed or baselined.
const ALLOWLIST_RULES = new Set([
  "basalt/no-direct-cloudflare-api",
  "basalt/no-strict-provider-decode",
]);
// A decode the rule recognises as a provider response is never "our own data".
const NEVER_ALLOWED = "Strict decode of a provider response";
// The plugins the rules come from. A different specifier could load a rule set that finds nothing.
export const PLUGINS = [
  { name: "basalt", specifier: "./plugin/basalt.mjs" },
  { name: "landmines-testing", specifier: "@interfere/landmines/testing" },
  { name: "landmines-structure", specifier: "@interfere/landmines/structure" },
  { name: "anti-slop", specifier: "./vendor/anti-slop/index.ts" },
  { name: "anti-slop-effect", specifier: "./vendor/anti-slop/effect/index.ts" },
];
const CONFIG_KEYS = new Set(["$schema", "plugins", "categories", "jsPlugins", "rules"]);
const OWNED_RULE = /^(?:basalt|landmines-[\w-]+|anti-slop(?:-effect)?)\//u;
const JS_PLUGIN = new Set(PLUGINS.map(({ name }) => name));

const builtIn = (rule: string) => !JS_PLUGIN.has(rule.split("/")[0]!);
const bare = (rule: string) => rule.split("/").at(-1)!;

/**
 * The built-in rules the owned configuration enables, by bare name: oxlint applies a disable
 * comment to a built-in rule whatever plugin prefix the comment writes before it.
 */
export const nativeRules = (config: Config) =>
  new Set(
    Object.entries(config.rules).flatMap(([rule, setting]) =>
      builtIn(rule) && !OFF.has(severity(setting)) ? [bare(rule)] : [],
    ),
  );

export type Counts = Record<string, Record<string, number>>;
export type Allowlist = Record<string, Record<string, { count: number; reason: string }>>;
export type Config = { rules: Record<string, unknown>; jsPlugins?: unknown } & Record<
  string,
  unknown
>;
export type Diagnostic = { rule: string; file: string; line: number; message: string };

const sorted = (counts: Counts) =>
  Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((rule) => [
        rule,
        Object.fromEntries(Object.entries(counts[rule]).sort(([a], [b]) => (a < b ? -1 : 1))),
      ]),
  ) satisfies Counts;
export const total = (counts: Record<string, number> = {}) =>
  Object.values(counts).reduce((sum, value) => sum + value, 0);
export const severity = (setting: unknown): unknown =>
  Array.isArray(setting) ? setting[0] : (setting ?? "off");
// Every way oxlint accepts to switch a rule off.
const OFF = new Set<unknown>(["off", "allow", 0]);
// An entry exempts findings only with an exact count and a reason someone can review.
const validEntry = (entry: unknown) => {
  const { count, reason } = (entry ?? {}) as { count?: unknown; reason?: unknown };
  return (
    Number.isInteger(count) &&
    Number(count) > 0 &&
    typeof reason === "string" &&
    reason.trim() !== ""
  );
};
const exempt = (allowlist: Allowlist, { rule, file, message }: Diagnostic) =>
  validEntry(allowlist[rule]?.[file]) && !message.startsWith(NEVER_ALLOWED);
const counted = (rule: string) => !NATIVE_ALLOWLIST.has(rule) && rule !== "oxlint/parse";

/**
 * A disable comment would hide a finding from the baseline. The only form allowed is a `//`
 * comment that names upstream rules and nothing else; any other mention is refused. `native`
 * holds the bare names of the built-in rules the owned configuration enables, which are owned
 * rules too under any prefix.
 */
export function directiveProblems(
  file: string,
  text: string,
  native: ReadonlySet<string> = new Set(),
) {
  const problems: string[] = [];
  for (const match of text.matchAll(/(?:oxlint|eslint)-disable/gu)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    const before = text.slice(lineStart, match.index);
    const after = text.slice(match.index + match[0].length, lineEnd === -1 ? undefined : lineEnd);
    const names = after
      .replace(/^(?:-next-line|-line)?/u, "")
      .replace(/--.*$/u, "")
      .split(/[\s,]+/u)
      .filter(Boolean);
    const upstreamOnly =
      /^\s*\/\/\s*$/u.test(before) &&
      names.length > 0 &&
      !names.some((name) => OWNED_RULE.test(name) || native.has(bare(name)) || /[*<>]/u.test(name));
    if (upstreamOnly) continue;
    problems.push(
      `${file}:${text.slice(0, match.index).split("\n").length} has a disable comment that is not a single \`//\` comment naming only upstream rules. Owned rules take no disable comments: fix the finding, or for a reasoned exception use scripts/owned-lint/allowlist.json.`,
    );
  }
  return problems;
}

export function count(diagnostics: readonly Diagnostic[]) {
  const counts: Counts = {};
  for (const { rule, file } of diagnostics) {
    counts[rule] ??= {};
    counts[rule][file] = (counts[rule][file] ?? 0) + 1;
  }
  return sorted(counts);
}

/** What --write-baseline records: landmines' own counts and the baseline, apart from allowlisted files. */
export function recordable(diagnostics: readonly Diagnostic[], allowlist: Allowlist) {
  const kept = diagnostics.filter((diagnostic) => !exempt(allowlist, diagnostic));
  return {
    native: count(kept.filter(({ rule }) => NATIVE_ALLOWLIST.has(rule))),
    baseline: count(kept.filter(({ rule }) => counted(rule))),
    unparsed: kept.filter(({ rule }) => rule === "oxlint/parse"),
  };
}

const located = (diagnostics: readonly Diagnostic[], rule: string, file: string) =>
  diagnostics
    .filter((diagnostic) => diagnostic.rule === rule && diagnostic.file === file)
    .map((diagnostic) => `  ${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`)
    .join("\n");

/** Every way the current findings disagree with the recorded baseline and allowlist. */
export function compare(
  diagnostics: readonly Diagnostic[],
  baseline: Counts,
  allowlist: Allowlist,
) {
  const problems: string[] = [];
  const allowed = count(diagnostics.filter((diagnostic) => exempt(allowlist, diagnostic)));
  for (const [rule, files] of Object.entries(allowlist)) {
    if (!ALLOWLIST_RULES.has(rule))
      problems.push(
        `allowlist.json: ${rule} takes no allowlist entries; fix or baseline its findings.`,
      );
    for (const [file, entry] of Object.entries(files)) {
      if (!validEntry(entry)) {
        problems.push(
          `allowlist.json: ${file} under ${rule} needs { "count": <findings>, "reason": "<why this is correct here>" }.`,
        );
        continue;
      }
      const found = allowed[rule]?.[file] ?? 0;
      if (found > entry.count)
        problems.push(
          `${file}: ${rule} found ${found}, allowlist allows ${entry.count} ("${entry.reason}"). Fix the new one, or if the same reason holds, raise its count in scripts/owned-lint/allowlist.json:\n${located(diagnostics, rule, file)}`,
        );
      else if (found < entry.count)
        problems.push(
          found
            ? `${file}: ${rule} is down to ${found} from ${entry.count}; lower its count in scripts/owned-lint/allowlist.json.`
            : `${file}: ${rule} has an allowlist entry but no findings; remove it from scripts/owned-lint/allowlist.json.`,
        );
    }
  }
  const kept = diagnostics.filter((diagnostic) => !exempt(allowlist, diagnostic));
  for (const diagnostic of kept.filter(({ rule }) => !counted(rule)))
    problems.push(
      `${diagnostic.file}:${diagnostic.line} ${diagnostic.rule}: ${diagnostic.message}${/stale|lower its/u.test(diagnostic.message) ? ` (${regenerate})` : ""}`,
    );
  const actual = count(kept.filter(({ rule }) => counted(rule)));
  for (const rule of [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort())
    for (const file of [
      ...new Set([...Object.keys(actual[rule] ?? {}), ...Object.keys(baseline[rule] ?? {})]),
    ].sort()) {
      const found = actual[rule]?.[file] ?? 0;
      const recorded = baseline[rule]?.[file] ?? 0;
      // A count that is not a number compares false both ways and would pass any finding.
      if (!Number.isInteger(recorded))
        problems.push(
          `baseline.json: ${file} under ${rule} is not a count of findings. Rewrite it: ${regenerate}`,
        );
      else if (found > recorded)
        problems.push(
          `${file}: ${rule} found ${found}, baseline allows ${recorded}. Fix the new one${found - recorded > 1 ? "s" : ""}:\n${located(kept, rule, file)}`,
        );
      else if (found < recorded)
        problems.push(
          `${file}: ${rule} is down to ${found} from ${recorded}. Lower the baseline: ${regenerate}`,
        );
    }
  return problems;
}

/** The configuration loads the pinned plugins, enforces what the base enforced, and nothing else. */
export function configProblems(current: Config, base: Config | undefined) {
  const problems = Object.keys(current)
    .filter((key) => !CONFIG_KEYS.has(key))
    .map(
      (key) =>
        `.oxlintrc.json: owned rules apply to every file in scope, so the configuration takes no "${key}".`,
    );
  if (JSON.stringify(current.jsPlugins) !== JSON.stringify(PLUGINS))
    problems.push(
      `.oxlintrc.json: jsPlugins must load exactly the pinned plugins: ${PLUGINS.map(({ name }) => name).join(", ")}.`,
    );
  // oxlint silently skips a built-in rule whose plugin is not in "plugins" (eslint's always run),
  // and reads a bare, differently prefixed or eslint-plugin- prefixed name as the same rule as
  // one already written, which can switch it off.
  const enabled = new Set(["eslint", ...(Array.isArray(current.plugins) ? current.plugins : [])]);
  const seen = new Set<string>();
  for (const rule of Object.keys(current.rules)) {
    if (!builtIn(rule)) continue;
    const plugin = rule.includes("/") ? rule.split("/")[0]! : "";
    if (!enabled.has(plugin) || seen.has(bare(rule)))
      problems.push(
        `.oxlintrc.json: ${rule} names no pinned JS plugin, so write it as a built-in rule, once, as <plugin>/<rule> with its plugin listed in "plugins".`,
      );
    seen.add(bare(rule));
  }
  for (const [rule, setting] of Object.entries(base?.rules ?? {}))
    if (severity(setting) === "error" && severity(current.rules[rule]) !== "error")
      problems.push(
        `.oxlintrc.json: ${rule} was enforced at the base commit and is not now. Owned rules are not switched off.`,
      );
  return problems;
}

/**
 * Options decide what an enforced rule finds, so a change to them is listed for review. Native
 * allowlist counts are left out: the ratchet below holds them.
 */
export function optionChanges(current: Config, base: Config) {
  const options = (rule: string, config: Config) => {
    const setting = config.rules[rule];
    return JSON.stringify(Array.isArray(setting) ? setting.slice(1) : [], (key, value) =>
      key === "allow" && NATIVE_ALLOWLIST.has(rule) ? undefined : value,
    );
  };
  return Object.keys(base.rules)
    .filter((rule) => severity(base.rules[rule]) === "error")
    .flatMap((rule) => {
      const [before, after] = [options(rule, base), options(rule, current)];
      return before === after ? [] : [`${rule} options ${before} -> ${after}`];
    });
}

/** New or raised allowlist entries are allowed with a reason; the summary lists them for review. */
export function allowlistAdditions(current: Allowlist, base: Allowlist) {
  return Object.entries(current).flatMap(([rule, files]) =>
    Object.entries(files)
      .filter(
        ([file, entry]) => validEntry(entry) && entry.count > (base[rule]?.[file]?.count ?? 0),
      )
      .map(
        ([file, entry]) =>
          `${file}: ${rule} allowlisted ${base[rule]?.[file]?.count ?? 0} -> ${entry.count}: ${entry.reason}`,
      ),
  );
}

export const nativeCounts = (config: Config) =>
  Object.fromEntries(
    [...NATIVE_ALLOWLIST].map((rule) => {
      const setting = config.rules[rule];
      const options = Array.isArray(setting)
        ? (setting[1] as { allow?: Record<string, number> } | undefined)
        : undefined;
      return [rule, options?.allow ?? {}];
    }),
  ) satisfies Counts;

export type BaseState = {
  baseline?: Counts;
  config?: Config;
  allowlist: Allowlist;
  /** The file's path at the base commit, following renames; undefined for a new file. */
  basePath: (file: string) => string | undefined;
  /** Whether that path was outside the gated scope, as code moved out of the release layer is. */
  enteredScope: (file: string) => boolean;
  /** Whether this change touches the file. */
  changed: (file: string) => boolean;
  /** Whether the rules or their pins differ from the base. */
  lintChanged: boolean;
};

/**
 * Committed counts only shrink against the base: a file may not gain recorded findings, and a
 * new file carries none (a renamed one keeps its old count). When the rules or their pins
 * change, a stricter rule may find more in files this change does not touch; those rises are
 * listed for review instead of failing.
 */
export function ratchet(
  current: Counts,
  base: Counts,
  state: BaseState,
  enforced: ReadonlySet<string>,
) {
  const problems: string[] = [];
  const notices: string[] = [];
  for (const [rule, files] of Object.entries(current)) {
    if (!enforced.has(rule)) continue;
    for (const [file, value] of Object.entries(files)) {
      const from = state.basePath(file);
      // Code moved into the gated scope brings its existing findings; the next change shrinks them.
      if (from && state.enteredScope(file)) {
        notices.push(
          `${file}: moved into the gated scope from ${from} with ${value} ${rule} finding(s), now baselined.`,
        );
        continue;
      }
      const recorded = from ? (base[rule]?.[from] ?? 0) : 0;
      if (value <= recorded) continue;
      const line = from
        ? `${file}: ${rule} baseline rose from ${recorded} to ${value}; baselines only shrink. Fix the code instead.`
        : `${file}: ${rule} is a new file with ${value} recorded finding(s); new files carry no baseline. Fix the code instead.`;
      if (state.lintChanged && from && !state.changed(file))
        notices.push(`Rules or pins changed, review this rise: ${line}`);
      else problems.push(line);
    }
  }
  return { problems, notices };
}

export function basePolicy(
  current: { config: Config; baseline: Counts; allowlist: Allowlist },
  base: BaseState,
) {
  const problems = configProblems(current.config, base.config);
  const notices = allowlistAdditions(current.allowlist, base.allowlist).map(
    (line) => `Allowlist addition, review its reason: ${line}`,
  );
  if (base.config)
    notices.push(
      ...optionChanges(current.config, base.config).map(
        (line) => `Rule options changed, review what they now find: ${line}`,
      ),
    );
  if (base.baseline && base.config) {
    const enforced = new Set(
      Object.keys(base.config.rules).filter(
        (rule) => severity(base.config!.rules[rule]) === "error",
      ),
    );
    for (const result of [
      ratchet(current.baseline, base.baseline, base, enforced),
      ratchet(nativeCounts(current.config), nativeCounts(base.config), base, enforced),
    ]) {
      problems.push(...result.problems);
      notices.push(...result.notices);
    }
  }
  return { problems, notices };
}
