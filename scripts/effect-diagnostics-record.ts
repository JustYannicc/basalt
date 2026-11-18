import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Records what the type checker reports on Effect code for the gate in effect-diagnostics.ts.

// Counted like rules: a file no type-check program reads, and a comment that hides diagnostics.
export const notTypeChecked = "notTypeChecked";
export const suppressionComment = "suppressionComment";

export type Counts = Record<string, Record<string, number>>;
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  code: number;
  rule: string;
  message: string;
}
export interface Program {
  diagnostics: Diagnostic[];
  files: string[];
}
interface EffectRecord {
  fingerprint: string;
  counts: Counts;
  diagnostics: Diagnostic[];
  misconfigured: Diagnostic[];
}

export const root = fileURLToPath(new URL("../", import.meta.url));
export const configPath = "tsconfig.effect.json";
const recordPath = ".generated/ci/effect-diagnostics.json";
// Programs that carry the plugin, and their descendants that must not replace it.
export const pluginConfigs = ["tsconfig.json", "tsconfig.worker.json", "tsconfig.pool.json"];
export const inheritingConfigs = [
  "tsconfig.stack.json",
  "tsconfig.obsidian.json",
  "tsconfig.recipes.json",
];
const effectCode = /^377\d{3}$/;
const header = /^(.+?)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): /;
// Matched in comment text only, so this file and its test do not count themselves.
const hidingDirective = /(?:\/\/|\/\*)[^\n]*@(?:effect-diagnostics|ts-nocheck)\b/g;

export const inScope = (file: string) =>
  /^(?:scripts|src)\//.test(file) &&
  !file.startsWith("scripts/release-barrier/") &&
  !file.includes("/node_modules/") &&
  /\.[cm]?tsx?$/.test(file) &&
  !/\.d\.[cm]?ts$/.test(file);

export function parseCompilerOutput(text: string, cwd: string) {
  const diagnostics: Diagnostic[] = [];
  const files: string[] = [];
  const other: string[] = [];
  let current: Diagnostic | undefined;
  for (const line of text.split("\n")) {
    const match = header.exec(line);
    if (match) {
      const [, file, row, column, severity, code] = match;
      const path = relative(root, resolve(cwd, file!)).replaceAll("\\", "/");
      current = {
        file: path,
        line: Number(row),
        column: Number(column),
        severity: severity!,
        code: Number(code),
        rule: "",
        message: line.slice(match[0].length),
      };
      diagnostics.push(current);
    } else if (isAbsolute(line) && existsSync(line)) {
      current = undefined;
      files.push(relative(root, line).replaceAll("\\", "/"));
    } else if (current && line) current.message += "\n" + line;
    else if (line) other.push(line);
  }
  // Effect diagnostics end with their rule name; anything else is keyed by its code.
  for (const diagnostic of diagnostics)
    diagnostic.rule =
      [...diagnostic.message.matchAll(/effect\(([A-Za-z]+)\)/g)].at(-1)?.[1] ??
      `TS${diagnostic.code}`;
  return { diagnostics, files, other };
}

const isEffect = (diagnostic: Diagnostic) => effectCode.test(String(diagnostic.code));
export const render = (d: Diagnostic) =>
  `${d.file}(${d.line},${d.column}): ${d.severity} TS${d.code}: ${d.message}`;

// Runs one program; prints everything except Effect diagnostics, which the gate reports.
export function compile(compiler: string, config: string): Program {
  const args = ["--noEmit", "--pretty", "false", "--listFiles", "-p", config];
  const result = spawnSync(compiler, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  const parsed = parseCompilerOutput(result.stdout, root);
  const printed = [...parsed.other, ...parsed.diagnostics.filter((d) => !isEffect(d)).map(render)];
  if (printed.length) process.stdout.write(printed.join("\n") + "\n");
  if (result.status !== 0) throw new Error(`${compiler} failed with exit ${result.status}`);
  return parsed;
}

export function scopeFiles() {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "scripts", "src"],
    { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 },
  );
  return [...new Set(listed.split("\0"))]
    .filter((file) => inScope(file) && existsSync(join(root, file)))
    .sort();
}

function fingerprint(files: readonly string[]) {
  const hash = createHash("sha256");
  const configs = [configPath, ...pluginConfigs, ...inheritingConfigs].filter((file) =>
    existsSync(join(root, file)),
  );
  for (const file of [...configs, ...files])
    hash.update(`${file}\0`).update(readFileSync(join(root, file)));
  return hash.digest("hex");
}

export function countSuppressions(text: string) {
  return text.match(hidingDirective)?.length ?? 0;
}

const add = (counts: Counts, rule: string, file: string, by = 1) => {
  counts[rule] ??= {};
  counts[rule][file] = (counts[rule][file] ?? 0) + by;
};

export function recordEffectDiagnostics(programs: readonly Program[]) {
  const files = scopeFiles();
  const read = new Set(programs.flatMap((program) => program.files));
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const counts: Counts = {};
  for (const diagnostic of programs.flatMap((program) => program.diagnostics)) {
    if (!isEffect(diagnostic) || diagnostic.severity !== "error" || !inScope(diagnostic.file))
      continue;
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diagnostic);
    add(counts, diagnostic.rule, diagnostic.file);
  }
  for (const file of files) {
    if (!read.has(file)) add(counts, notTypeChecked, file);
    const hidden = countSuppressions(readFileSync(join(root, file), "utf8"));
    if (hidden) add(counts, suppressionComment, file, hidden);
  }
  // A misspelt rule name would otherwise leave that rule at its default severity.
  const misconfigured = programs
    .flatMap((program) => program.diagnostics)
    .filter((d) => d.rule === "unknownRuleName");
  const record: EffectRecord = {
    fingerprint: fingerprint(files),
    counts,
    diagnostics,
    misconfigured,
  };
  mkdirSync(dirname(join(root, recordPath)), { recursive: true });
  writeFileSync(join(root, recordPath), JSON.stringify(record));
}

export function readRecord(): EffectRecord {
  if (!existsSync(join(root, recordPath)))
    throw new Error(`${recordPath} is missing. Run node scripts/typecheck.ts first.`);
  const record: EffectRecord = JSON.parse(readFileSync(join(root, recordPath), "utf8"));
  if (record.fingerprint !== fingerprint(scopeFiles()))
    throw new Error(
      `${recordPath} was recorded for other sources. Run node scripts/typecheck.ts again.`,
    );
  return record;
}
