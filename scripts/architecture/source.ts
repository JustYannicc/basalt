import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export interface Module {
  id: string;
  code: string;
  bindings: string[];
  libraries: string[];
}
export interface OutsideService {
  id: string;
  hosts: string[];
  sdks: string[];
}
export interface Dependency {
  source: string;
  target: string;
  evidence: string;
}
export const values = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value?.split("|") ?? []).map(v => v.trim()).filter(Boolean);

export function filesBelow(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap(name =>
    name === "node_modules" || name.startsWith(".") ? [] : filesBelow(join(path, name)));
}

export function runtimeFiles(root: string): string[] {
  return ["src", "packages", "containers"].flatMap(dir => filesBelow(join(root, dir)))
    .filter(path => /\.[cm]?[jt]sx?$/.test(path) && !/\.(test|spec)\.|\.d\.ts$/.test(path));
}

export function owner(file: string, modules: Module[]): Module | undefined {
  return modules.filter(m => file === m.code || file.startsWith(m.code + "/"))
    .sort((a, b) => b.code.length - a.code.length)[0];
}

export function moduleErrors(root: string, modules: Module[]): string[] {
  const errors: string[] = [];
  const paths = new Set<string>();
  for (const module of modules) {
    if (paths.has(module.code)) errors.push(`Duplicate code mapping: ${module.code}`);
    paths.add(module.code);
    if (!existsSync(join(root, module.code))) errors.push(`${module.id}: missing code ${module.code}`);
    if (resolve(root, module.code) !== root && !resolve(root, module.code).startsWith(root + "/"))
      errors.push(`${module.id}: code path escapes repository`);
  }
  for (const parent of ["src", "packages", "containers"]) {
    const path = join(root, parent);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path)) {
      const code = `${parent}/${entry}`;
      if (entry.startsWith(".") || /\.(test|spec)\.|\.d\.ts$/.test(entry)) continue;
      if (!modules.some(m => m.code === code || m.code.startsWith(code + "/")))
        errors.push(`Unmodelled module: ${code}`);
    }
  }
  for (const path of runtimeFiles(root)) {
    const file = relative(root, path);
    if (!owner(file, modules)) errors.push(`Unmodelled code: ${file}`);
  }
  return errors;
}

function resolveImport(root: string, file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    for (const path of filesBelow(join(root, "packages")).filter(p => p.endsWith("/package.json"))) {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      if (specifier === manifest.name || specifier.startsWith(manifest.name + "/"))
        return relative(root, dirname(path));
    }
    return undefined;
  }
  const path = resolve(dirname(join(root, file)), specifier.replace(/\.js$/, ".ts"));
  return relative(root, path);
}

// Runtime source only. The pinned dependency is one module with its own implementation.
export function sourceDependencies(root: string, modules: Module[], services: OutsideService[]): {
  dependencies: Dependency[];
  errors: string[];
} {
  const dependencies: Dependency[] = [];
  const errors: string[] = [];
  const add = (source: string, target: string, evidence: string) =>
    dependencies.push({ source, target, evidence });
  for (const path of runtimeFiles(root)) {
    const file = relative(root, path);
    const module = owner(file, modules);
    if (!module) continue;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const report = (node: ts.Node, message: string) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      errors.push(`${file}:${line}: ${message}`);
    };
    const checkImport = (node: ts.Node, specifier: string) => {
      if (specifier.startsWith("node:") && !["node:http", "node:https", "node:http2", "node:net", "node:tls"].includes(specifier)) return;
      // These implement effects, deployment declarations and local service bindings.
      // They do not identify an outside API. Concrete network destinations still count.
      if (["effect", "alchemy", "@cloudflare/containers"].some(library => specifier === library || specifier.startsWith(library + "/"))) return;
      const local = resolveImport(root, file, specifier);
      if (local === "scripts/architecture/gen/model.ts") return;
      if (local !== undefined) {
        const target = owner(local, modules);
        if (!target) report(node, `Import has no module: ${specifier}`);
        else if (target.id !== module.id) add(module.id, target.id, `${file}: ${specifier}`);
        return;
      }
      const service = services.find(s => s.sdks.some(sdk => specifier === sdk || specifier.startsWith(sdk + "/")));
      if (service) add(module.id, service.id, `${file}: ${specifier}`);
      else if (!module.libraries.some(lib => specifier === lib || specifier.startsWith(lib + "/")))
        report(node, `Unmodelled SDK or library: ${specifier}`);
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        checkImport(node, node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) checkImport(node, argument.text);
        else report(node, "Dynamic import needs a statically known module");
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const text = ts.isTemplateExpression(node) ? node.head.text : node.text;
        if (/^(?:https?|wss?):\/\//.test(text)) {
          try {
            const host = new URL(text).hostname;
            const service = services.find(s => s.hosts.some(h => host === h || (h.startsWith("*.") && host.endsWith(h.slice(1)))));
            if (service) add(module.id, service.id, `${file}: ${host}`);
            else report(node, `Unmodelled outside host: ${host}`);
          } catch { report(node, "Outside URL has a dynamic host"); }
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ["fetch", "globalThis.fetch"].includes(node.initializer.getText(source)))
        report(node, "Aliased outbound fetch needs an explicit gateway adapter");
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(source);
        if (expression === "fetch" || expression === "globalThis.fetch") {
          const argument = node.arguments[0];
          // Literal URLs are checked above. Computed destinations must cross a modelled gateway.
          if (!argument || !ts.isStringLiteralLike(argument))
            report(node, "Computed outbound fetch needs an explicit gateway adapter");
        } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "fetch") {
          const receiver = node.expression.expression.getText(source);
          const binding = module.bindings.find(b => {
            const name = b.split("=")[0];
            return receiver === name || receiver === `env.${name}` || receiver === `this.env.${name}`;
          });
          if (binding) add(module.id, binding.split("=")[1]!, `${file}: ${receiver}`);
          else report(node, `Unmodelled fetch binding: ${receiver}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { dependencies, errors };
}
