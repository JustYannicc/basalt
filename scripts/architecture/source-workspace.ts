import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filesBelow } from "./files.ts";
import { StaticValues } from "./static-values.ts";

type Location = { file: string; line: number };
export type PythonScan = {
  imports: (Location & { name: string; level: number; target: string | null; stdlib: boolean })[];
  urls: (Location & { value: string; sink: boolean })[];
  errors: (Location & { message: string })[];
};
type PythonResult = { scan: PythonScan; error?: never } | { error: string; scan?: never };
const fingerprint = (input: string) => createHash("sha256").update(input).digest("hex");

function parseSources(
  root: string,
  paths: string[],
  manifests: Map<string, string>,
  contents: Map<string, string>,
) {
  const packages = [...manifests].map(([path, text]) => ({
    name: JSON.parse(text).name as string,
    code: relative(root, dirname(path)),
  }));
  return {
    values: new StaticValues(paths, contents),
    resolveImport(file: string, specifier: string): string | undefined {
      if (!specifier.startsWith("."))
        return packages.find(
          (pkg) => specifier === pkg.name || specifier.startsWith(pkg.name + "/"),
        )?.code;
      return relative(root, resolve(dirname(join(root, file)), specifier.replace(/\.js$/, ".ts")));
    },
  };
}

/** A suite owns this cache; file paths and bytes guard reuse across independent checks. */
export class SourceWorkspace {
  private parsed?: { fingerprint: string; sources: ReturnType<typeof parseSources> };
  private python?: { fingerprint: string; result: PythonResult };

  read(root: string, paths: string[]) {
    const contents = new Map(paths.map((path) => [resolve(path), readFileSync(path, "utf8")]));
    const manifests = new Map(
      filesBelow(join(root, "packages"))
        .filter((path) => path.endsWith("/package.json"))
        .map((path) => [path, readFileSync(path, "utf8")]),
    );
    const key = fingerprint(JSON.stringify([resolve(root), [...contents], [...manifests]]));
    if (this.parsed?.fingerprint !== key)
      this.parsed = { fingerprint: key, sources: parseSources(root, paths, manifests, contents) };
    return this.parsed.sources;
  }

  scanPython(texts: Record<string, string>): PythonResult {
    const input = JSON.stringify(texts);
    const scanner = fileURLToPath(new URL("./python-scan.py", import.meta.url));
    const key = fingerprint(JSON.stringify([input, readFileSync(scanner, "utf8")]));
    if (this.python?.fingerprint === key) return this.python.result;
    const process = spawnSync("python3", ["-I", scanner], {
      input,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (process.error || process.status !== 0)
      return {
        error: `Python AST scan failed: ${process.error?.message ?? process.stderr.trim()}`,
      };
    let scan: PythonScan;
    try {
      scan = JSON.parse(process.stdout) as PythonScan;
    } catch {
      return { error: "Python AST scan returned invalid JSON" };
    }
    const result = { scan };
    this.python = { fingerprint: key, result };
    return result;
  }
}
