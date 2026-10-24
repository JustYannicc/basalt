import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { configurationIssues } from "./configuration.ts";
import { executionFiles, isExecutionPath } from "./execution-files.ts";
import { filesBelow } from "./files.ts";
import { pythonDependencies } from "./python.ts";
import { StaticValues } from "./static-values.ts";

export { filesBelow } from "./files.ts";

export interface Module {
  id: string;
  code: string;
  bindings: string[];
  libraries: string[];
  configuration?: boolean;
  endpointHosts?: string[];
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

export function runtimeFiles(root: string, modules: Module[] = []): string[] {
  return executionFiles(root, modules)
    .filter(path => /\.[cm]?[jt]sx?$/.test(path));
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
    for (const entry of readdirSync(path).sort()) {
      const code = `${parent}/${entry}`;
      if (!isExecutionPath(code)) continue;
      if (!modules.some(m => m.code === code || m.code.startsWith(code + "/")))
        errors.push(`Unmodelled module: ${code}`);
    }
  }
  for (const path of runtimeFiles(root, modules)) {
    const file = relative(root, path).replaceAll("\\", "/");
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

function fetchBinding(call: ts.CallExpression, module: Module, source: ts.SourceFile): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "fetch") return undefined;
  const receiver = call.expression.expression;
  const names = [receiver.getText(source)];
  if (ts.isCallExpression(receiver)) names.push(receiver.expression.getText(source));
  return module.bindings.find(binding => {
    const name = binding.split("=")[0];
    return names.some(candidate => candidate === name || candidate === `env.${name}` || candidate === `this.env.${name}`);
  });
}

function usesBoundTransport(node: ts.Node, module: Module, source: ts.SourceFile): boolean {
  for (let parent = node.parent; parent && !ts.isStatement(parent); parent = parent.parent)
    if (ts.isCallExpression(parent) && fetchBinding(parent, module, source)) return true;
  return false;
}

function isGlobalFetch(expression: ts.Expression, values: StaticValues): boolean {
  return (ts.isIdentifier(expression) && expression.text === "fetch" && values.isUnshadowedGlobal(expression)) ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === "fetch" &&
      ts.isIdentifier(expression.expression) && expression.expression.text === "globalThis" &&
      values.isUnshadowedGlobal(expression.expression));
}

function isGlobalRequire(expression: ts.Expression, values: StaticValues): boolean {
  return ts.isIdentifier(expression) && expression.text === "require" && values.isUnshadowedGlobal(expression);
}

function matchesHost(host: string, hosts: string[]): boolean {
  return hosts.some(candidate => host === candidate || (candidate.startsWith("*.") && host.endsWith(candidate.slice(1))));
}

// Source checks parse owned code and bind only that closed file set. They never execute source.
export function sourceDependencies(root: string, modules: Module[], services: OutsideService[]): {
  dependencies: Dependency[];
  errors: string[];
} {
  const dependencies: Dependency[] = [];
  const errors: string[] = [];
  const add = (source: string, target: string, evidence: string) =>
    dependencies.push({ source, target, evidence });
  const paths = runtimeFiles(root, modules);
  const staticValues = new StaticValues(paths);
  for (const path of paths) {
    const file = relative(root, path).replaceAll("\\", "/");
    const module = owner(file, modules);
    if (!module) continue;
    const source = staticValues.source(path);
    if (!source) {
      errors.push(`${file}: Unable to parse source file`);
      continue;
    }
    const report = (node: ts.Node, message: string) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      errors.push(`${file}:${line}: ${message}`);
    };
    if (module.configuration) {
      for (const issue of configurationIssues(source)) report(issue.node, issue.message);
      continue;
    }
    const checkImport = (node: ts.Node, specifier: string, dynamicPackage = false) => {
      if (specifier === "cloudflare:workers") return;
      if (specifier.startsWith("node:") && !["node:http", "node:https", "node:http2", "node:net", "node:tls"].includes(specifier)) return;
      const declaredLibrary = module.libraries.some(lib => specifier === lib || specifier.startsWith(lib + "/"));
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
      else if (dynamicPackage && !declaredLibrary) report(node, `Unmodelled dynamic package import: ${specifier}`);
      else if (!dynamicPackage && !declaredLibrary &&
        !["effect", "alchemy", "@cloudflare/containers"].some(library => specifier === library || specifier.startsWith(library + "/")))
        report(node, `Unmodelled SDK or library: ${specifier}`);
    };
    const observedHosts = new Set<string>();
    const addHost = (node: ts.Node, host: string) => {
      if (usesBoundTransport(node, module, source)) return;
      const service = services.find(candidate => matchesHost(host, candidate.hosts));
      if (service) {
        add(module.id, service.id, `${file}: ${host}`);
        observedHosts.add(host);
        return;
      }
      const endpoint = modules.find(candidate => candidate.id !== module.id && candidate.endpointHosts?.includes(host));
      if (endpoint) {
        add(module.id, endpoint.id, `${file}: ${host}`);
        observedHosts.add(host);
        return;
      }
      report(node, `Unmodelled outside host: ${host}`);
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        checkImport(node, node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isGlobalRequire(node.expression, staticValues))) {
        const argument = node.arguments[0];
        const specifier = argument && staticValues.moduleSpecifier(argument);
        if (specifier === undefined) report(node, "Dynamic import needs a statically known module");
        else checkImport(node, specifier, argument !== undefined && staticValues.packageSpecifier(argument));
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const prefix = ts.isTemplateExpression(node) ? node.head.text : node.text;
        if (/^(?:https?|wss?):\/\//.test(prefix)) {
          if (usesBoundTransport(node, module, source)) return;
          const host = staticValues.urlHost(node) ?? staticValues.boundedUrlHost(node);
          if (host) addHost(node, host);
          else report(node, "Outside URL has a dynamic host");
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer && isGlobalFetch(node.initializer, staticValues))
        report(node, "Aliased outbound fetch needs an explicit gateway adapter");
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "fetch" &&
        !isGlobalFetch(node.expression, staticValues)) {
        const binding = fetchBinding(node, module, source);
        if (binding) add(module.id, binding.split("=")[1]!, `${file}: ${node.expression.expression.getText(source)}`);
        else report(node, `Unmodelled fetch binding: ${node.expression.expression.getText(source)}`);
      }
      if (ts.isCallExpression(node) && isGlobalFetch(node.expression, staticValues)) {
        const binding = fetchBinding(node, module, source);
        if (binding) {
          add(module.id, binding.split("=")[1]!, `${file}: ${node.expression.getText(source)}`);
        } else {
          const argument = node.arguments[0];
          const literalUrl = argument && (ts.isStringLiteralLike(argument) || ts.isTemplateExpression(argument));
          if (!argument) report(node, "Computed outbound fetch needs an explicit gateway adapter");
          else if (!literalUrl) {
            const host = staticValues.urlHost(argument) ?? staticValues.boundedUrlHost(argument);
            if (!host) report(node, "Computed outbound fetch needs a statically known host or an explicit gateway adapter");
            else if (!observedHosts.has(host)) addHost(node, host);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const python = pythonDependencies(root, modules, services);
  return { dependencies: [...dependencies, ...python.dependencies], errors: [...errors, ...python.errors] };
}
