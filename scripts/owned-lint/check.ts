import { execFileSync, spawnSync } from "node:child_process";
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
  type Allowlist,
  type BaseState,
  type Config,
  type Counts,
  type Diagnostic,
} from "./baseline.ts";
import {
  MANIFEST,
  VENDOR,
  currentVendor,
  nextManifest,
  sha256,
  vendorPolicy,
  vendorProblems,
  vendorState,
  vendored,
} from "./vendor.ts";

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

export function lint(
  files: readonly string[],
  { config = configPath, cwd = root, timeout = 120_000 } = {},
) {
  if (!existsSync(oxlint))
    throw new Error("scripts/owned-lint is not installed. Run npm run prepare:upstream.");
  const result = spawnSync(
    process.execPath,
    [oxlint, "-c", config, "--no-ignore", "-f", "json", ...files],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout },
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
    diagnostics = lint(files, { config: scratch });
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

// Records the vendored code files with their hashes, after an upstream update replaced the copy.
function writeVendor() {
  const files = listFiles(root, (file) => SCOPE.test(file), VENDOR);
  const { manifest, changes } = nextManifest(files);
  writeJson(join(root, MANIFEST), manifest);
  console.log(
    `Vendored manifest written: ${files.length} files${changes.length ? `; ${changes.join("; ")}` : ""}.`,
  );
}

function baseState(base: string) {
  if (
    !/^[0-9a-f]{40}$/u.test(base) ||
    spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root }).status !== 0
  )
    throw new Error(`BASE_SHA ${base} is not a commit in this repository.`);
  const showText = (file: string) => {
    const result = spawnSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    // git exits 128 for a path the base lacks; any other failure must not read as "absent",
    // which would skip the ratchet.
    if (result.status === 128) return undefined;
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(`git show ${base}:${file} failed: ${result.stderr}`);
    return result.stdout;
  };
  const show = (path: string) => {
    const text = showText(relative(root, path));
    return text === undefined ? undefined : JSON.parse(text);
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
    policy: {
      baseline: show(baselinePath) as Counts | undefined,
      config: show(configPath) as Config | undefined,
      allowlist: (show(allowlistPath) ?? {}) as Allowlist,
      basePath: (file: string) => renamed.get(file) ?? (tracked.has(file) ? file : undefined),
      enteredScope: (file: string) => OUTSIDE.test(renamed.get(file) ?? file),
      changed: (file: string) => changed.has(file) || !tracked.has(file),
      lintChanged,
    } satisfies BaseState,
    vendor: vendorState(showText),
  };
}

// Only the named files' entries, for a check of the files an agent just edited.
const only = <T>(byRule: Record<string, Record<string, T>>, files: ReadonlySet<string>) =>
  Object.fromEntries(
    Object.entries(byRule).map(([rule, byFile]) => [
      rule,
      Object.fromEntries(Object.entries(byFile).filter(([file]) => files.has(file))),
    ]),
  );

type Entries = { config: Config; baseline: Counts; allowlist: Allowlist };
type Checked = { files: number; findings: number; problems: string[]; notices: string[] };
const readEntries = (): Entries => ({
  config: readJson<Config>(configPath, { rules: {} }),
  baseline: readJson<Counts>(baselinePath, {}),
  allowlist: readJson<Allowlist>(allowlistPath, {}),
});

function findings(files: readonly string[], entries: Entries, timeout?: number) {
  const diagnostics = lint(files, { timeout });
  const native = nativeRules(entries.config);
  return {
    files: files.length,
    findings: diagnostics.length,
    problems: [
      ...files.flatMap((file) =>
        directiveProblems(file, readFileSync(join(root, file), "utf8"), native),
      ),
      ...compare(diagnostics, entries.baseline, entries.allowlist),
    ],
  };
}

/**
 * The owned rules over named files, against only those files' baseline and allowlist entries.
 * The base ratchet reads the whole baseline, so it is left to the full run.
 */
export function checkFiles(files: readonly string[], timeout?: number): Checked {
  const entries = readEntries();
  const named = new Set(files);
  const result = findings(
    files,
    {
      ...entries,
      baseline: only(entries.baseline, named),
      allowlist: only(entries.allowlist, named),
    },
    timeout,
  );
  return {
    ...result,
    problems: [...result.problems, ...configProblems(entries.config, undefined)],
    notices: [],
  };
}

/** Every file in scope and the vendored copy; with a base commit, the ratchet against it too. */
function checkAll(base: string | undefined): Checked {
  const entries = readEntries();
  const result = findings(scopedFiles(), entries);
  const problems = [...result.problems, ...vendorProblems(currentVendor().manifest, sha256)];
  if (base === undefined)
    return {
      ...result,
      problems: [...problems, ...configProblems(entries.config, undefined)],
      notices: [],
    };
  const state = baseState(base);
  const policies = [basePolicy(entries, state.policy), vendorPolicy(currentVendor(), state.vendor)];
  return {
    ...result,
    problems: [...problems, ...policies.flatMap((policy) => policy.problems)],
    notices: policies.flatMap((policy) => policy.notices),
  };
}

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
  // A mistyped path would otherwise check nothing and pass.
  const missing = named.filter((file) => !existsSync(resolve(file)));
  if (missing.length) throw new Error(`No such file: ${missing.join(", ")}.`);
  const files = [
    ...new Set(named.map((file) => relative(root, resolve(file))).filter(inScope)),
  ].sort();
  if (named.length && !files.length) {
    console.log("Owned lint: none of the named files is in scope.");
    process.exit(0);
  }
  const started = Date.now();
  const { problems, notices, ...counted } = named.length
    ? checkFiles(files)
    : checkAll(process.env.BASE_SHA || undefined);
  console.log(
    `Owned lint: ${counted.files} files, ${counted.findings} findings (baselined or allowlisted unless listed below), ${Date.now() - started} ms.`,
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
