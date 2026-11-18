import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const configPath = join(here, ".oxlintrc.json");
const baselinePath = join(here, "baseline.json");
const allowlistPath = join(here, "allowlist.json");
const oxlint = join(here, "node_modules/.bin/oxlint");
const regenerate = "npm run lint:owned -- --write-baseline";

// Basalt-owned code. The release layer under scripts/release-barrier is being replaced by
// Alchemy and is not gated; everything else in scripts/ and src/ is, including new files.
const SCOPE = /^(?:scripts|src)\/.+\.(?:[cm]?[jt]s|[jt]sx)$/u;
const OUTSIDE = /^scripts\/release-barrier\/|(?:^|\/)node_modules\/|^scripts\/architecture\/gen\//u;
// landmines keeps these counts itself, in the rule's options, and reports a stale count.
const NATIVE_ALLOWLIST = new Set([
  "landmines-testing/no-fixed-sleep",
  "landmines-testing/no-flake-masking",
  "landmines-testing/strict-msw",
  "landmines-testing/no-unsignaled-poll",
]);

type Counts = Record<string, Record<string, number>>;
type Allowlist = Record<string, Record<string, string>>;
type Diagnostic = { rule: string; file: string; line: number; message: string };

const readJson = <T>(path: string, fallback: T) => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
};
const sorted = (counts: Counts) =>
  Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((rule) => [
        rule,
        Object.fromEntries(Object.entries(counts[rule]).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  ) satisfies Counts;
const ruleId = (code: string) => code.replace(/^([\w-]+)\((.+)\)$/u, "$1/$2");

export function scopedFiles(cwd = root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => SCOPE.test(file) && !OUTSIDE.test(file))
    .sort();
}

export function lint(files: readonly string[], config = configPath, cwd = root) {
  const result = spawnSync(oxlint, ["-c", config, "-f", "json", ...files], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let report: {
    diagnostics: {
      code: string;
      filename: string;
      message: string;
      labels?: { span: { line: number } }[];
    }[];
    number_of_files: number;
  };
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `oxlint exited ${result.status} without a JSON report:\n${result.stderr.slice(-4000)}`,
    );
  }
  // A path oxlint ignores reports nothing, which looks the same as clean.
  if (report.number_of_files !== files.length)
    throw new Error(
      `oxlint checked ${report.number_of_files} of ${files.length} files; a path is ignored. Run it outside ignored directories.`,
    );
  return report.diagnostics.map(
    (diagnostic) =>
      ({
        rule: ruleId(diagnostic.code),
        file: relative(cwd, join(cwd, diagnostic.filename)),
        line: diagnostic.labels?.[0]?.span.line ?? 0,
        message: diagnostic.message,
      }) satisfies Diagnostic,
  );
}

export function count(diagnostics: readonly Diagnostic[]) {
  const counts: Counts = {};
  for (const { rule, file } of diagnostics) {
    counts[rule] ??= {};
    counts[rule][file] = (counts[rule][file] ?? 0) + 1;
  }
  return sorted(counts);
}

/** Every way the current findings disagree with the recorded baseline and allowlist. */
export function compare(
  diagnostics: readonly Diagnostic[],
  baseline: Counts,
  allowlist: Allowlist,
) {
  const problems: string[] = [];
  const allowed = (rule: string, file: string) => Boolean(allowlist[rule]?.[file]);
  const kept = diagnostics.filter(({ rule, file }) => !allowed(rule, file));
  for (const [rule, files] of Object.entries(allowlist))
    for (const file of Object.keys(files))
      if (!diagnostics.some((diagnostic) => diagnostic.rule === rule && diagnostic.file === file))
        problems.push(
          `${file}: ${rule} has an allowlist entry but no findings; remove it from scripts/owned-lint/allowlist.json.`,
        );
  for (const diagnostic of kept.filter(({ rule }) => NATIVE_ALLOWLIST.has(rule)))
    problems.push(
      `${diagnostic.file}:${diagnostic.line} ${diagnostic.rule}: ${diagnostic.message}`,
    );
  const actual = count(kept.filter(({ rule }) => !NATIVE_ALLOWLIST.has(rule)));
  const rules = new Set([...Object.keys(actual), ...Object.keys(baseline)]);
  for (const rule of [...rules].sort()) {
    const files = new Set([
      ...Object.keys(actual[rule] ?? {}),
      ...Object.keys(baseline[rule] ?? {}),
    ]);
    for (const file of [...files].sort()) {
      const found = actual[rule]?.[file] ?? 0;
      const recorded = baseline[rule]?.[file] ?? 0;
      if (found > recorded) {
        const lines = kept.filter(
          (diagnostic) => diagnostic.rule === rule && diagnostic.file === file,
        );
        problems.push(
          `${file}: ${rule} found ${found}, baseline allows ${recorded}. Fix the new one${found - recorded > 1 ? "s" : ""}:\n` +
            lines
              .map((diagnostic) => `  ${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`)
              .join("\n"),
        );
      } else if (found < recorded)
        problems.push(
          `${file}: ${rule} is down to ${found} from ${recorded}. Lower the baseline: ${regenerate}`,
        );
    }
  }
  return problems;
}

/** With a base commit, a committed baseline or allowance may only shrink against the base's. */
export function ratchet(current: Counts, base: Counts, existedAtBase: (file: string) => boolean) {
  const problems: string[] = [];
  for (const [rule, files] of Object.entries(current)) {
    const total = (counts: Record<string, number> = {}) =>
      Object.values(counts).reduce((sum, value) => sum + value, 0);
    for (const [file, value] of Object.entries(files))
      if (existedAtBase(file) && value > (base[rule]?.[file] ?? 0))
        problems.push(
          `${file}: ${rule} baseline rose from ${base[rule]?.[file] ?? 0} to ${value}; baselines only shrink. Fix the code instead.`,
        );
    // A renamed file keeps its findings under a new path: only the rule's total may not rise.
    if (total(files) > total(base[rule]))
      problems.push(
        `${rule}: baseline total rose from ${total(base[rule])} to ${total(files)}; baselines only shrink.`,
      );
  }
  return problems;
}

const nativeCounts = (config: { rules: Record<string, unknown> }) =>
  Object.fromEntries(
    [...NATIVE_ALLOWLIST].map((rule) => {
      const setting = config.rules[rule];
      const options = Array.isArray(setting)
        ? (setting[1] as { allow?: Record<string, number> } | undefined)
        : undefined;
      return [rule, options?.allow ?? {}];
    }),
  ) satisfies Counts;
const atBase = (base: string, path: string) => {
  const result = spawnSync("git", ["show", `${base}:${relative(root, path)}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : undefined;
};

function writeBaseline(files: readonly string[]) {
  const config = readJson<{ rules: Record<string, unknown> }>(configPath, { rules: {} });
  for (const rule of NATIVE_ALLOWLIST) config.rules[rule] = "error";
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const allowlist = readJson<Allowlist>(allowlistPath, {});
  const kept = lint(files).filter(({ rule, file }) => !allowlist[rule]?.[file]);
  const native = count(kept.filter(({ rule }) => NATIVE_ALLOWLIST.has(rule)));
  for (const rule of NATIVE_ALLOWLIST)
    config.rules[rule] = native[rule] ? ["error", { allow: native[rule] }] : "error";
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const baseline = count(kept.filter(({ rule }) => !NATIVE_ALLOWLIST.has(rule)));
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  const total = (counts: Counts) =>
    Object.values(counts).reduce(
      (sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0),
      0,
    );
  console.log(
    `Owned lint baseline written: ${total(baseline)} findings in baseline.json, ${total(native)} in landmines allowlists.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = scopedFiles();
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(files);
    process.exit(0);
  }
  const started = Date.now();
  const diagnostics = lint(files);
  const baseline = readJson<Counts>(baselinePath, {});
  const allowlist = readJson<Allowlist>(allowlistPath, {});
  const problems = compare(diagnostics, baseline, allowlist);
  const base = process.env.BASE_SHA;
  if (base) {
    const baseBaseline = atBase(base, baselinePath);
    const baseConfig = atBase(base, configPath);
    const existed = (file: string) =>
      spawnSync("git", ["cat-file", "-e", `${base}:${file}`], { cwd: root }).status === 0;
    if (baseBaseline) problems.push(...ratchet(baseline, JSON.parse(baseBaseline), existed));
    if (baseConfig)
      problems.push(
        ...ratchet(
          nativeCounts(readJson(configPath, { rules: {} })),
          nativeCounts(JSON.parse(baseConfig)),
          existed,
        ),
      );
  }
  console.log(
    `Owned lint: ${files.length} files, ${diagnostics.length} findings (baselined or allowlisted unless listed below), ${Date.now() - started} ms.`,
  );
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(
      `\n${problems.length} owned lint problem(s). Rules and baseline: scripts/owned-lint/README.md`,
    );
    process.exit(1);
  }
}
