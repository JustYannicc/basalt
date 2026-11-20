import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_ALLOWLIST,
  basePolicy,
  compare,
  configProblems,
  directiveProblems,
  recordable,
  severity,
  total,
  type Allowlist,
  type BaseState,
  type Config,
  type Counts,
  type Diagnostic,
} from "./baseline.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const configPath = join(here, ".oxlintrc.json");
const baselinePath = join(here, "baseline.json");
const allowlistPath = join(here, "allowlist.json");
const oxlint = join(here, "node_modules/oxlint/bin/oxlint");

// Basalt-owned code: everything in scripts/ and src/, including new files, apart from installed
// and generated code.
const SCOPE = /^(?:scripts|src)\/.+\.(?:[cm]?[jt]s|[jt]sx)$/u;
const OUTSIDE = /(?:^|\/)node_modules\/|^scripts\/architecture\/gen\//u;
// Changing these may change what the rules find, so a rise against the base is listed for
// review instead of failing; the rule cases in rules.test.ts guard the change.
const LINT_INPUTS = [
  "scripts/owned-lint/plugin",
  "scripts/owned-lint/package.json",
  "scripts/owned-lint/bun.lock",
];
const readJson = <T>(path: string, fallback: T) => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
};
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
export function scopedFiles(cwd = root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => SCOPE.test(file) && !OUTSIDE.test(file) && existsSync(join(cwd, file)))
    .sort();
}

export function lint(files: readonly string[], config = configPath, cwd = root) {
  if (!existsSync(oxlint))
    throw new Error("scripts/owned-lint is not installed. Run npm run prepare:upstream.");
  const result = spawnSync(
    process.execPath,
    [oxlint, "-c", config, "--no-ignore", "-f", "json", ...files],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  let report: {
    diagnostics: {
      code?: string;
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
      `oxlint checked ${report.number_of_files} of ${files.length} files: a path is being ignored.`,
    );
  return report.diagnostics.map(
    (diagnostic) =>
      ({
        // A file oxlint cannot parse reports a diagnostic without a rule.
        rule: diagnostic.code
          ? diagnostic.code.replace(/^([\w-]+)\((.+)\)$/u, "$1/$2")
          : "oxlint/parse",
        file: relative(cwd, join(cwd, diagnostic.filename)),
        line: diagnostic.labels?.[0]?.span.line ?? 0,
        message: diagnostic.message,
      }) satisfies Diagnostic,
  );
}

function writeBaseline(files: readonly string[]) {
  const config = readJson<Config>(configPath, { rules: {} });
  const unlimited = { ...config, rules: { ...config.rules } };
  for (const rule of NATIVE_ALLOWLIST)
    if (severity(config.rules[rule]) === "error") unlimited.rules[rule] = "error";
  // Lint with a sibling copy so a failed run leaves the committed configuration untouched.
  const scratch = join(here, ".oxlintrc.baseline.json");
  writeJson(scratch, unlimited);
  let diagnostics: Diagnostic[];
  try {
    diagnostics = lint(files, scratch);
  } finally {
    rmSync(scratch, { force: true });
  }
  const { native, baseline, unparsed } = recordable(
    diagnostics,
    readJson<Allowlist>(allowlistPath, {}),
  );
  if (unparsed.length)
    throw new Error(
      `oxlint could not parse:\n${unparsed.map((diagnostic) => `  ${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`).join("\n")}`,
    );
  for (const rule of NATIVE_ALLOWLIST)
    if (severity(config.rules[rule]) === "error")
      config.rules[rule] = native[rule] ? ["error", { allow: native[rule] }] : "error";
  writeJson(configPath, config);
  writeJson(baselinePath, baseline);
  const sum = (counts: Counts) =>
    Object.values(counts).reduce((all, files) => all + total(files), 0);
  console.log(
    `Owned lint baseline written: ${sum(baseline)} findings in baseline.json, ${sum(native)} in landmines allowlists.`,
  );
}

function baseState(base: string) {
  if (
    !/^[0-9a-f]{40}$/u.test(base) ||
    spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root }).status !== 0
  )
    throw new Error(`BASE_SHA ${base} is not a commit in this repository.`);
  const show = (path: string) => {
    const result = spawnSync("git", ["show", `${base}:${relative(root, path)}`], {
      cwd: root,
      encoding: "utf8",
    });
    return result.status === 0 ? JSON.parse(result.stdout) : undefined;
  };
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split(
      "\0",
    );
  const tracked = new Set(
    git(["ls-tree", "-r", "-z", "--name-only", base, "--", "scripts", "src"]),
  );
  // The working tree against the base, with renames: a renamed file keeps its old count.
  const renamed = new Map<string, string>();
  const changed = new Set<string>();
  // Renames from anywhere under scripts/ and src/, so code moved in from outside the gated scope is found.
  const entries = git(["diff", "-z", "--name-status", "-M", base, "--", "scripts", "src"]);
  for (let index = 0; index < entries.length - 1;) {
    const status = entries[index++]!;
    if (status.startsWith("R")) {
      const from = entries[index++]!;
      const to = entries[index++]!;
      renamed.set(to, from);
      changed.add(to);
    } else changed.add(entries[index++]!);
  }
  const lintChanged =
    spawnSync("git", ["diff", "--quiet", base, "--", ...LINT_INPUTS], { cwd: root }).status !== 0;
  return {
    baseline: show(baselinePath) as Counts | undefined,
    config: show(configPath) as Config | undefined,
    allowlist: (show(allowlistPath) ?? {}) as Allowlist,
    basePath: (file: string) => renamed.get(file) ?? (tracked.has(file) ? file : undefined),
    enteredScope: (file: string) => OUTSIDE.test(renamed.get(file) ?? file),
    changed: (file: string) => changed.has(file) || !tracked.has(file),
    lintChanged,
  } satisfies BaseState;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // pnpm, unlike npm, passes the `--` of `npm run lint:owned -- --write-baseline` through.
  const unknown = process.argv
    .slice(2)
    .filter((argument) => argument !== "--" && argument !== "--write-baseline");
  if (unknown.length)
    throw new Error(`Unknown argument ${unknown.join(" ")}; the only option is --write-baseline.`);
  const files = scopedFiles();
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(files);
    process.exit(0);
  }
  const started = Date.now();
  const diagnostics = lint(files);
  const config = readJson<Config>(configPath, { rules: {} });
  const baseline = readJson<Counts>(baselinePath, {});
  const allowlist = readJson<Allowlist>(allowlistPath, {});
  const problems = [
    ...files.flatMap((file) => directiveProblems(file, readFileSync(join(root, file), "utf8"))),
    ...compare(diagnostics, baseline, allowlist),
  ];
  const notices: string[] = [];
  if (process.env.BASE_SHA) {
    const policy = basePolicy({ config, baseline, allowlist }, baseState(process.env.BASE_SHA));
    problems.push(...policy.problems);
    notices.push(...policy.notices);
  } else problems.push(...configProblems(config, undefined));
  console.log(
    `Owned lint: ${files.length} files, ${diagnostics.length} findings (baselined or allowlisted unless listed below), ${Date.now() - started} ms.`,
  );
  if (notices.length) {
    console.log(notices.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY)
      writeFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Owned lint\n\n${notices.map((line) => `- ${line}`).join("\n")}\n`,
        { flag: "a" },
      );
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(
      `\n${problems.length} owned lint problem(s). Rules and baseline: scripts/owned-lint/README.md`,
    );
    process.exit(1);
  }
}
