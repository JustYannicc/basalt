import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Records what the type checker reports on Effect code for the gate in effect-diagnostics.ts.

// Counted like rules: a file no type-check program reads, a directive that hides diagnostics, and
// JavaScript that imports Effect, which no program checks.
export const notTypeChecked = "notTypeChecked";
export const suppressionComment = "suppressionComment";
export const effectInJavaScript = "effectInJavaScript";

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
  // Whether the config's extends chain reaches tsconfig.effect.json without replacing its plugin
  // or skipping checks; only such programs cover the files they read.
  gated: boolean;
}
interface EffectRecord {
  fingerprint: string;
  counts: Counts;
  canary: Record<string, number>;
  diagnostics: Diagnostic[];
  misconfigured: Diagnostic[];
}

export const root = fileURLToPath(new URL("../", import.meta.url));
export const configPath = "tsconfig.effect.json";
export const canaryPath = "scripts/effect-diagnostics-canary.ts";
const recordPath = ".generated/ci/effect-diagnostics.json";
// Programs that carry the plugin, and their descendants that must not replace it.
export const pluginConfigs = ["tsconfig.json", "tsconfig.worker.json", "tsconfig.pool.json"];
export const inheritingConfigs = [
  "tsconfig.stack.json",
  "tsconfig.obsidian.json",
  "tsconfig.recipes.json",
];
const effectCode = /^377\d{3}$/;
// Configuration diagnostics, such as an unknown rule name, carry no location.
const header = /^(?:(.+?)\((\d+),(\d+)\): )?(error|warning|suggestion|message) TS(\d+): /;
// The compiler honours these tags anywhere in a file, comments and strings alike, so they are
// counted anywhere; code that names one builds it from parts.
const hidingDirective =
  /@(?:effect-diagnostics|effect-leakable-service|effect-expect-leaking|ts-nocheck)\b/g;
// Any module specifier naming effect, or a call on an Effect namespace however it was imported.
const usesEffect = /["'`]effect(?:\/[^"'`]*)?["'`]|\bEffect\s*(?:\.\s*[A-Za-z]+\s*\(|:)/;

const owned = (file: string) => /^(?:scripts|src)\//.test(file);
export const inScope = (file: string) =>
  owned(file) && /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file);
const isJavaScript = (file: string) => owned(file) && /\.[cm]?jsx?$/.test(file);

export function parseCompilerOutput(text: string, cwd: string) {
  const diagnostics: Diagnostic[] = [];
  const files: string[] = [];
  const other: string[] = [];
  let current: Diagnostic | undefined;
  for (const line of text.split("\n")) {
    const match = header.exec(line);
    if (match) {
      const [, file, row, column, severity, code] = match;
      current = {
        file: file ? relative(root, resolve(cwd, file)).replaceAll("\\", "/") : "",
        line: Number(row ?? 0),
        column: Number(column ?? 0),
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
  `${d.file ? `${d.file}(${d.line},${d.column}): ` : ""}${d.severity}` +
  `${d.code ? ` TS${d.code}` : ""}: ${d.message}`;

function runCompiler(compiler: string, config: string) {
  const args = ["--noEmit", "--pretty", "false", "--listFiles", "-p", config];
  return new Promise<{ stdout: string; status: number | null }>((done, fail) => {
    const child = spawn(compiler, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ stdout: Buffer.concat(chunks).toString("utf8"), status }));
  });
}

// The programs are independent, so the lanes run concurrently, each lane in order: the root
// program alone beside the rest takes about as long as it does by itself and peaks near 7 GiB,
// where all five at once peak near 9 GiB. Everything except Effect diagnostics, which the gate
// reports, is printed in program order.
export async function compilePrograms(compiler: string, lanes: readonly (readonly string[])[]) {
  const configs = lanes.flat();
  const finished = await Promise.all(
    lanes.map(async (lane) => {
      const results = [];
      for (const config of lane) results.push(await runCompiler(compiler, config));
      return results;
    }),
  );
  const results = finished.flat();
  const programs: Program[] = [];
  const failed: string[] = [];
  results.forEach(({ stdout, status }, index) => {
    const config = configs[index]!;
    const parsed = parseCompilerOutput(stdout, root);
    const printed = [
      ...parsed.other,
      ...parsed.diagnostics.filter((d) => !isEffect(d)).map(render),
    ];
    if (printed.length) process.stdout.write(printed.join("\n") + "\n");
    if (status !== 0) failed.push(`${compiler} -p ${config} failed with exit ${status}`);
    programs.push({ ...parsed, gated: carriesPlugin(config) });
  });
  if (failed.length) throw new Error(failed.join("; "));
  return programs;
}

function carriesPlugin(config: string) {
  const effect = resolve(root, configPath);
  const seen = new Set<string>();
  for (let file = resolve(root, config); !seen.has(file);) {
    seen.add(file);
    let parsed: { extends?: unknown; compilerOptions?: { plugins?: unknown; noCheck?: unknown } };
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
    if (parsed.compilerOptions?.noCheck) return false;
    if (file === effect) return true;
    if (parsed.compilerOptions?.plugins !== undefined) return false;
    if (typeof parsed.extends !== "string" || !/^[./]/.test(parsed.extends)) return false;
    file = resolve(dirname(file), parsed.extends);
  }
  return false;
}

function sourceFiles() {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "scripts", "src"],
    { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 },
  );
  return [...new Set(listed.split("\0"))]
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(join(root, file)))
    .sort();
}

export const scopeFiles = () => sourceFiles().filter(inScope);

// Declarations and JavaScript change what the compiler reports, so they count towards freshness.
function fingerprint(files: readonly string[]) {
  const hash = createHash("sha256");
  const configs = [configPath, ...pluginConfigs, ...inheritingConfigs].filter((file) =>
    existsSync(join(root, file)),
  );
  for (const file of [...configs, ...files])
    hash.update(`${file}\0`).update(readFileSync(join(root, file)));
  return hash.digest("hex");
}

// UTF-16 only with a byte-order mark, as the compiler reads it; a NUL byte anywhere else would let
// a file read differently here than in the compiler, so it counts as hiding diagnostics.
export function decode(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: bytes.subarray(2).toString("utf16le"), hidden: false };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return {
      text: Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)))
        .swap16()
        .toString("utf16le"),
      hidden: false,
    };
  return { text: bytes.toString("utf8"), hidden: bytes.includes(0) };
}

export function suppressionLines(text: string) {
  return [...text.matchAll(hidingDirective)].map(
    (match) => text.slice(0, match.index).split("\n").length,
  );
}

const add = (counts: Counts, rule: string, file: string, by = 1) => {
  counts[rule] ??= {};
  counts[rule][file] = (counts[rule][file] ?? 0) + by;
};

export function recordEffectDiagnostics(programs: readonly Program[]) {
  const sources = sourceFiles();
  const files = sources.filter(inScope);
  // Generated and ignored sources are neither fingerprinted nor counted.
  const scope = new Set(files);
  const read = new Set(
    programs.filter((program) => program.gated).flatMap((program) => program.files),
  );
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const counts: Counts = {};
  for (const diagnostic of programs.flatMap((program) => program.diagnostics)) {
    if (!isEffect(diagnostic) || diagnostic.severity !== "error" || !scope.has(diagnostic.file))
      continue;
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diagnostic);
    add(counts, diagnostic.rule, diagnostic.file);
  }
  for (const file of sources) {
    if (!owned(file)) continue;
    const { text, hidden } = decode(readFileSync(join(root, file)));
    if (isJavaScript(file)) {
      if (usesEffect.test(text)) add(counts, effectInJavaScript, file);
      continue;
    }
    if (!inScope(file)) continue;
    if (!read.has(file)) add(counts, notTypeChecked, file);
    const hiding = suppressionLines(text).map((line) => ({ line, why: "A tag here hides" }));
    if (hidden) hiding.push({ line: 1, why: "A NUL byte makes this file unreadable and hides" });
    for (const { line, why } of hiding) {
      add(counts, suppressionComment, file);
      diagnostics.push({
        file,
        line,
        column: 0,
        severity: "error",
        code: 0,
        rule: suppressionComment,
        message: `${why} Effect diagnostics from the gate.`,
      });
    }
  }
  // The canary's sites never enter the baseline; the gate expects exactly these on every run.
  const canary: Record<string, number> = {};
  for (const diagnostic of diagnostics)
    if (diagnostic.file === canaryPath)
      canary[diagnostic.rule] = (canary[diagnostic.rule] ?? 0) + 1;
  for (const rule of Object.keys(counts)) {
    delete counts[rule]![canaryPath];
    if (!Object.keys(counts[rule]!).length) delete counts[rule];
  }
  // A misspelt rule name would otherwise leave that rule at its default severity.
  const misconfigured = [
    ...new Map(
      programs
        .flatMap((program) => program.diagnostics)
        .filter((d) => d.rule === "unknownRuleName")
        .map((d) => [d.message, d]),
    ).values(),
  ];
  const record: EffectRecord = {
    fingerprint: fingerprint(sources),
    counts,
    canary,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.file !== canaryPath),
    misconfigured,
  };
  mkdirSync(dirname(join(root, recordPath)), { recursive: true });
  writeFileSync(join(root, recordPath), JSON.stringify(record));
}

export function readRecord(): EffectRecord {
  if (!existsSync(join(root, recordPath)))
    throw new Error(`${recordPath} is missing. Run node scripts/typecheck.ts first.`);
  const record: EffectRecord = JSON.parse(readFileSync(join(root, recordPath), "utf8"));
  if (record.fingerprint !== fingerprint(sourceFiles()))
    throw new Error(
      `${recordPath} was recorded for other sources. Run node scripts/typecheck.ts again.`,
    );
  return record;
}
