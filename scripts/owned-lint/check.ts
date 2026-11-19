import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_ALLOWLIST,
  basePolicy,
  compare,
  configProblems,
  directiveProblems,
  nativeRules,
  recordable,
  severity,
  total,
  VENDOR,
  vendorProblems,
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

// Basalt-owned code. The release layer under scripts/release-barrier is being replaced by
// Alchemy and is not gated; everything else in scripts/ and src/ is, including new files.
const SCOPE = /^(?:scripts|src)\/.+\.(?:[cm]?[jt]s|[jt]sx)$/u;
const OUTSIDE = /^scripts\/release-barrier\/|(?:^|\/)node_modules\/|^scripts\/architecture\/gen\//u;
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
const vendorPath = join(root, VENDOR, "manifest.json");
// Vendored rules keep their upstream form so an update stays a diff against upstream; no
// formatter or linter rewrites them. Only the files under vendor/ recorded with their upstream
// hash count as vendored: any other file there is Basalt code and is checked like the rest.
const VENDORED = new Map<string, string>(Object.entries(readJson<object>(vendorPath, {})));
export const vendored = (file: string) => file.startsWith(VENDOR) && VENDORED.has(file);
const sha256 = (file: string) => {
  const path = join(root, file);
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : undefined;
};
// Changing these may change what the rules find, so a rise against the base is listed for
// review instead of failing; the rule cases in rules.test.ts guard the change.
const LINT_INPUTS = [
  "scripts/owned-lint/plugin",
  VENDOR,
  "scripts/owned-lint/package.json",
  "scripts/owned-lint/bun.lock",
];
export const inScope = (file: string) => SCOPE.test(file) && !OUTSIDE.test(file) && !vendored(file);
const listFiles = (cwd: string, keep: (file: string) => boolean, ...paths: string[]) =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...paths], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => keep(file) && existsSync(join(cwd, file)))
    .sort();
export const scopedFiles = (cwd = root) => listFiles(cwd, inScope);

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

function writeBaseline(files: readonly string[] = scopedFiles()) {
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

// Records the vendored code files with their hashes, after copying in an upstream update.
function writeVendor() {
  const files = listFiles(root, (file) => SCOPE.test(file), VENDOR);
  writeJson(vendorPath, Object.fromEntries(files.map((file) => [file, sha256(file)])));
  console.log(`Vendored manifest written: ${files.length} files.`);
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
  // Renames from anywhere under scripts/ and src/, so code moved out of the release layer is found.
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
    vendor: new Map<string, string>(Object.entries(show(vendorPath) ?? {})),
    upstreamRecorded: git(["diff", "-z", "--name-only", base, "--", VENDOR]).some((file) =>
      file.endsWith("/UPSTREAM.md"),
    ),
    basePath: (file: string) => renamed.get(file) ?? (tracked.has(file) ? file : undefined),
    enteredScope: (file: string) => OUTSIDE.test(renamed.get(file) ?? file),
    changed: (file: string) => changed.has(file) || !tracked.has(file),
    lintChanged,
  } satisfies BaseState;
}

// Only the named files' entries, for a check of the files an agent just edited.
const only = <T>(byRule: Record<string, Record<string, T>>, files: ReadonlySet<string>) =>
  Object.fromEntries(
    Object.entries(byRule).map(([rule, byFile]) => [
      rule,
      Object.fromEntries(Object.entries(byFile).filter(([file]) => files.has(file))),
    ]),
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const writers = { "--write-baseline": writeBaseline, "--write-vendor": writeVendor };
  const named = process.argv.slice(2).filter((argument) => !Object.hasOwn(writers, argument));
  const unknown = named.filter((argument) => argument.startsWith("-"));
  if (unknown.length)
    throw new Error(
      `Unknown option ${unknown.join(" ")}; the options are --write-baseline and --write-vendor, or name files to check.`,
    );
  const chosen = Object.entries(writers).filter(([option]) => process.argv.includes(option));
  if (chosen.length > 1) throw new Error("Run --write-baseline and --write-vendor one at a time.");
  for (const [option, write] of chosen) {
    if (named.length) throw new Error(`${option} records every file; name none.`);
    write();
    process.exit(0);
  }
  const files = named.length
    ? [
        ...new Set(
          named
            .map((file) => relative(root, resolve(file)))
            .filter((file) => inScope(file) && existsSync(join(root, file))),
        ),
      ].sort()
    : scopedFiles();
  if (named.length && !files.length) {
    console.log("Owned lint: none of the named files is in scope.");
    process.exit(0);
  }
  const started = Date.now();
  const diagnostics = lint(files);
  const config = readJson<Config>(configPath, { rules: {} });
  const selected = new Set(files);
  const baseline = named.length
    ? only(readJson<Counts>(baselinePath, {}), selected)
    : readJson<Counts>(baselinePath, {});
  const allowlist = named.length
    ? only(readJson<Allowlist>(allowlistPath, {}), selected)
    : readJson<Allowlist>(allowlistPath, {});
  const native = nativeRules(config);
  const problems = [
    ...files.flatMap((file) =>
      directiveProblems(file, readFileSync(join(root, file), "utf8"), native),
    ),
    ...compare(diagnostics, baseline, allowlist),
    ...(named.length ? [] : vendorProblems(VENDORED, sha256)),
  ];
  const notices: string[] = [];
  // The base ratchet reads the whole baseline, so a check of named files leaves it to the full run.
  if (process.env.BASE_SHA && !named.length) {
    const policy = basePolicy(
      { config, baseline, allowlist, vendor: VENDORED },
      baseState(process.env.BASE_SHA),
    );
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
