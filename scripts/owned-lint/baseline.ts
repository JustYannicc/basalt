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
const DIRECTIVE = /(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b([^\n]*)/gu;

export type Counts = Record<string, Record<string, number>>;
export type Allowlist = Record<string, Record<string, { count: number; reason: string }>>;
export type Config = { rules: Record<string, unknown> };
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
export const severity = (setting: unknown) =>
  Array.isArray(setting) ? setting[0] : (setting ?? "off");

/** A disable comment would hide a finding from the baseline, so the owned rules take none. */
export function directiveProblems(file: string, text: string) {
  const problems: string[] = [];
  for (const match of text.matchAll(DIRECTIVE)) {
    const names = match[1]!
      .replace(/\*\/.*$|--.*$/u, "")
      .split(/[\s,]+/u)
      .filter(Boolean);
    if (names.length && !names.some((name) => /^(?:basalt|landmines-[\w-]+)\//u.test(name)))
      continue;
    const line = text.slice(0, match.index).split("\n").length;
    problems.push(
      `${file}:${line} disables ${names.length ? names.join(", ") : "every rule"}. Owned rules take no disable comments: fix the finding, or for a reasoned exception use scripts/owned-lint/allowlist.json.`,
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
  const allowed = count(diagnostics.filter(({ rule, file }) => allowlist[rule]?.[file]));
  for (const [rule, files] of Object.entries(allowlist)) {
    if (!ALLOWLIST_RULES.has(rule))
      problems.push(
        `allowlist.json: ${rule} takes no allowlist entries; fix or baseline its findings.`,
      );
    for (const [file, { count: recorded, reason }] of Object.entries(files)) {
      const found = allowed[rule]?.[file] ?? 0;
      if (found > recorded)
        problems.push(
          `${file}: ${rule} found ${found}, allowlist allows ${recorded} ("${reason}"). Fix the new one, or if the same reason holds, raise its count in scripts/owned-lint/allowlist.json:\n${located(diagnostics, rule, file)}`,
        );
      else if (found < recorded)
        problems.push(
          found
            ? `${file}: ${rule} is down to ${found} from ${recorded}; lower its count in scripts/owned-lint/allowlist.json.`
            : `${file}: ${rule} has an allowlist entry but no findings; remove it from scripts/owned-lint/allowlist.json.`,
        );
    }
  }
  const kept = diagnostics.filter(({ rule, file }) => !allowlist[rule]?.[file]);
  for (const diagnostic of kept.filter(
    ({ rule }) => NATIVE_ALLOWLIST.has(rule) || rule === "oxlint/parse",
  ))
    problems.push(
      `${diagnostic.file}:${diagnostic.line} ${diagnostic.rule}: ${diagnostic.message}${/stale|lower its/u.test(diagnostic.message) ? ` (${regenerate})` : ""}`,
    );
  const actual = count(
    kept.filter(({ rule }) => !NATIVE_ALLOWLIST.has(rule) && rule !== "oxlint/parse"),
  );
  for (const rule of [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort())
    for (const file of [
      ...new Set([...Object.keys(actual[rule] ?? {}), ...Object.keys(baseline[rule] ?? {})]),
    ].sort()) {
      const found = actual[rule]?.[file] ?? 0;
      const recorded = baseline[rule]?.[file] ?? 0;
      if (found > recorded)
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

/**
 * With a base commit, a committed count may only shrink against the base's. A rule the base
 * did not configure brings its own baseline. A renamed file may carry its findings; the
 * rule's total may not rise.
 */
export function ratchet(
  current: Counts,
  base: Counts,
  existedAtBase: (file: string) => boolean,
  baseRules: ReadonlySet<string>,
) {
  const problems: string[] = [];
  for (const [rule, files] of Object.entries(current)) {
    if (!baseRules.has(rule)) continue;
    for (const [file, value] of Object.entries(files))
      if (existedAtBase(file) && value > (base[rule]?.[file] ?? 0))
        problems.push(
          `${file}: ${rule} baseline rose from ${base[rule]?.[file] ?? 0} to ${value}; baselines only shrink. Fix the code instead.`,
        );
    if (total(files) > total(base[rule]))
      problems.push(
        `${rule}: baseline total rose from ${total(base[rule])} to ${total(files)}; baselines only shrink.`,
      );
  }
  return problems;
}

/** A rule the base enforced may not be switched off or removed. */
export function configProblems(current: Config, base: Config) {
  return Object.entries(base.rules)
    .filter(
      ([rule, setting]) =>
        severity(setting) === "error" && severity(current.rules[rule]) !== "error",
    )
    .map(
      ([rule]) =>
        `.oxlintrc.json: ${rule} was enforced at the base commit and is not now. Owned rules are not switched off.`,
    );
}

/** New or raised allowlist entries are allowed with a reason; the summary lists them for review. */
export function allowlistAdditions(current: Allowlist, base: Allowlist) {
  return Object.entries(current).flatMap(([rule, files]) =>
    Object.entries(files)
      .filter(([file, entry]) => entry.count > (base[rule]?.[file]?.count ?? 0))
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
