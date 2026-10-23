import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dependency, Module, OutsideService } from "./source.ts";
import { filesBelow, owner } from "./source.ts";
import { containerRuntimeFiles } from "./container-files.ts";

type Location = { file: string; line: number };
type Scan = {
  imports: (Location & { name: string; level: number; target: string | null; stdlib: boolean })[];
  urls: (Location & { value: string; sink: boolean })[];
  errors: (Location & { message: string })[];
};
const testFile = (file: string) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)(?:test_.*|.*_test)\.py$|\.(?:test|spec)\.py$/.test(file);
const matches = (name: string, candidates: string[]) =>
  candidates.some(candidate => name === candidate || name.startsWith(candidate + "."));
const networkStdlib = /^(?:socket|ssl|http\.client|ftplib|smtplib|imaplib|poplib|telnetlib|xmlrpc\.client|asyncio)(?:\.|$)/;

// Only source-owned Python participates. Build-stage release acquisition and the
// released executable have separate ownership from this runtime source check.
export function pythonDependencies(root: string, modules: Module[], services: OutsideService[]): {
  dependencies: Dependency[];
  errors: string[];
} {
  const dependencies: Dependency[] = [];
  const errors: string[] = [];
  const paths = new Set(["src", "packages"].flatMap(dir => filesBelow(join(root, dir))));
  for (const dockerfile of filesBelow(join(root, "containers")).filter(file => file.endsWith("/Dockerfile"))) {
    try { for (const file of containerRuntimeFiles(dirname(dockerfile))) paths.add(file); }
    catch (error) { errors.push(`${relative(root, dockerfile)}: ${String(error)}`); }
  }
  const texts: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const file = relative(root, path).replaceAll("\\", "/");
    if (!file.endsWith(".py") || testFile(file)) continue;
    if (!owner(file, modules)) { errors.push(`Unmodelled Python code: ${file}`); continue; }
    texts[file] = readFileSync(path, "utf8");
  }
  if (!Object.keys(texts).length) return { dependencies, errors };
  const scanner = fileURLToPath(new URL("./python-scan.py", import.meta.url));
  const process = spawnSync("python3", ["-I", scanner], {
    input: JSON.stringify(texts), encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (process.error || process.status !== 0) {
    errors.push(`Python AST scan failed: ${process.error?.message ?? process.stderr.trim()}`);
    return { dependencies, errors };
  }
  let scan: Scan;
  try { scan = JSON.parse(process.stdout) as Scan; }
  catch { errors.push("Python AST scan returned invalid JSON"); return { dependencies, errors }; }
  const report = (location: Location, message: string) => errors.push(`${location.file}:${location.line}: ${message}`);
  const add = (location: Location, target: string, evidence: string) => {
    const source = owner(location.file, modules)!.id;
    if (source !== target) dependencies.push({ source, target, evidence: `${location.file}:${location.line}: ${evidence}` });
  };
  for (const error of scan.errors) report(error, error.message);
  for (const entry of scan.imports) {
    const module = owner(entry.file, modules)!;
    if (entry.target) {
      const target = owner(entry.target, modules);
      if (target) add(entry, target.id, entry.name);
      else report(entry, `Import has no module: ${entry.name}`);
      continue;
    }
    if (entry.level) { report(entry, `Own Python import cannot be resolved: ${entry.name}`); continue; }
    const service = services.find(service => matches(entry.name, service.sdks));
    if (service) add(entry, service.id, entry.name);
    else if (matches(entry.name, module.libraries)) continue;
    else if (!entry.stdlib || networkStdlib.test(entry.name)) report(entry, `Unmodelled SDK or library: ${entry.name}`);
  }
  for (const entry of scan.urls) {
    const authority = /^(?:https?|wss?):\/\/([^/\s?#]*)/i.exec(entry.value)?.[1];
    if (!authority || authority.includes("<dynamic>")) {
      report(entry, "Outside URL has a dynamic or unsupported host");
      continue;
    }
    let host: string;
    try { host = new URL(entry.value).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
    catch { report(entry, "Outside URL has a dynamic or unsupported host"); continue; }
    if (host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."))) continue;
    const service = services.find(service => service.hosts.some(candidate =>
      host === candidate || candidate.startsWith("*.") && host.endsWith(candidate.slice(1))));
    if (service) add(entry, service.id, host);
    else report(entry, `Unmodelled outside host: ${host}`);
  }
  return { dependencies, errors: [...new Set(errors)] };
}
