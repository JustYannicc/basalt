import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "../architecture/typescript.ts";
import { executedArgv } from "./e2e-workflow.ts";
import { addTo, directoryFiles } from "./inputs.ts";

export const isCode = (path: string) => /\.[cm]?[jt]sx?$/.test(path);
export const isTest = (path: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

/**
 * One file a source file names. `module` and `type` are import specifiers, relative to the file;
 * `spawn` is a script it starts with `node` or `bun`, relative to the repository; `path` is any
 * other literal that names a file: a relative string such as a module path held in a constant
 * or `new URL(…, import.meta.url)`, or an argument of a path or file call.
 */
export type Reference = { kind: "module" | "type" | "spawn" | "path"; specifier: string };

const spawners = /^(?:run|spawn|spawnSync|execFile|execFileSync|ChildProcess\.make)$/;
const pathCalls =
  /^(?:(?:path|posix)\.)?(?:join|resolve)$|^(?:fs\.)?(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|lstatSync|copyFileSync|cpSync|createReadStream)$/;

/** CLI wrappers name their child scripts as argv strings rather than imports. */
export function spawnedScripts(node: ts.CallExpression, source: ts.SourceFile) {
  if (!spawners.test(node.expression.getText(source))) return [];
  const executable = node.arguments[0];
  const runner =
    executable && ts.isStringLiteralLike(executable)
      ? executable.text
      : executable?.getText(source) === "process.execPath"
        ? "node"
        : "";
  const list = node.arguments[1];
  if (!["node", "bun"].includes(runner) || !list || !ts.isArrayLiteralExpression(list)) return [];
  const argv = list.elements.map((argument) => {
    if (ts.isStringLiteralLike(argument)) return argument.text;
    if (
      ts.isCallExpression(argument) &&
      ["join", "resolve"].includes(argument.expression.getText(source))
    )
      return (
        argument.arguments
          .find((part) => ts.isStringLiteralLike(part) && /^(?:e2e|scripts)\//.test(part.text))
          ?.getText(source)
          .slice(1, -1) ?? "<dynamic>"
      );
    return "<dynamic>";
  });
  return executedArgv(runner, argv).map((path) => path.replace(/^\.\//, ""));
}

export function sourceReferences(file: string, text: string): Reference[] {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const references: Reference[] = [];
  // A `require` made with createRequire resolves from where it was made, not from this file.
  const localRequire = /\b(?:const|let|var)\s+require\s*=/.test(text);
  const add = (kind: Reference["kind"], node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) references.push({ kind, specifier: node.text });
  };
  const walk = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      const typeOnly =
        node.importClause?.isTypeOnly ||
        (!!bindings &&
          ts.isNamedImports(bindings) &&
          !node.importClause?.name &&
          bindings.elements.length > 0 &&
          bindings.elements.every((item) => item.isTypeOnly));
      add(typeOnly ? "type" : "module", node.moduleSpecifier);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (!!clause &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((item) => item.isTypeOnly));
      add(typeOnly ? "type" : "module", node.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add("module", node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add("type", node.argument.literal);
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (callee === "require" && !localRequire) ||
        callee === "import.meta.resolve"
      )
        add("module", node.arguments[0]);
      if (pathCalls.test(callee)) for (const argument of node.arguments) add("path", argument);
      for (const path of spawnedScripts(node, source))
        references.push({ kind: "spawn", specifier: path });
    }
    if (
      ts.isStringLiteralLike(node) &&
      /^\.\.?\//.test(node.text) &&
      !ts.isImportDeclaration(node.parent) &&
      !ts.isExportDeclaration(node.parent) &&
      !ts.isLiteralTypeNode(node.parent) &&
      !ts.isExternalModuleReference(node.parent) &&
      !(
        ts.isCallExpression(node.parent) &&
        (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ["require", "import.meta.resolve"].includes(node.parent.expression.getText(source)))
      )
    )
      add("path", node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return references;
}

export function trackedFiles(root: string) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

const candidates = (path: string) => [
  path,
  path.replace(/\.js$/, ".ts"),
  path.replace(/\.jsx$/, ".tsx"),
  path.replace(/\.mjs$/, ".mts"),
  ...["ts", "tsx", "mjs", "js"].flatMap((extension) => [
    path + "." + extension,
    path + "/index." + extension,
  ]),
];

/**
 * Which repository files import or read which. Built from the committed tree: `.upstream`,
 * installed dependencies and generated output are never tracked, so they are not nodes, though an
 * import of a prepared upstream file stays an edge to its `.upstream/` path.
 */
export function importGraph(root: string, files = trackedFiles(root)) {
  const tracked = new Set(files);
  const below = directoryFiles(files);
  // Local packages that others depend on by name, such as `file:../src/setup`.
  const packages = new Map<string, string>();
  for (const manifest of files.filter((file) => file.endsWith("package.json")))
    for (const [name, version] of Object.entries<string>({
      ...JSON.parse(readFileSync(join(root, manifest), "utf8")).dependencies,
    }))
      if (typeof version === "string" && version.startsWith("file:"))
        packages.set(name, posix.normalize(posix.join(posix.dirname(manifest), version.slice(5))));
  const resolved = (from: string, reference: Reference): string[] => {
    const directory = posix.dirname(from);
    if (reference.kind === "spawn")
      return tracked.has(reference.specifier) ? [reference.specifier] : [];
    if (reference.kind === "path") {
      // A literal may be relative to the repository, to the file, or to the prepared upstream
      // checkout that scripts run commands in.
      const paths = [reference.specifier, directory, ".upstream"]
        .map((base, index) => (index ? posix.join(base, reference.specifier) : base))
        .map((path) => posix.normalize(path))
        .filter((path) => !path.startsWith("../") && !path.startsWith("/"));
      // Only a named file counts: directory literals are mostly bases for other paths, so the
      // directories read whole are declared as runtime reads instead.
      return [...new Set(paths.filter((path) => tracked.has(path)))];
    }
    const specifier = reference.specifier;
    if (!specifier.startsWith(".")) {
      const name = [...packages.keys()].find(
        (candidate) => specifier === candidate || specifier.startsWith(candidate + "/"),
      );
      if (!name) return [];
      const home = packages.get(name)!;
      const exports = JSON.parse(readFileSync(join(root, home, "package.json"), "utf8")).exports;
      const entry = exports?.["." + specifier.slice(name.length)];
      const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
      return typeof target === "string"
        ? [posix.normalize(posix.join(home, target))]
        : (below.get(home) ?? []).filter((file) => isCode(file) && !isTest(file));
    }
    const path = posix.normalize(posix.join(directory, specifier));
    if (path.startsWith(".upstream/")) return [path];
    const found = candidates(path).find((candidate) => tracked.has(candidate));
    if (found) return [found];
    if (path.startsWith("../") || /(?:^|\/)node_modules\//.test(path)) return [];
    // An import of untracked output, such as code compiled into `.generated`, depends on whatever
    // builds it: every file below the nearest directory that has tracked files.
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      const files = below.get(path.slice(0, at));
      if (files) return files;
    }
    throw new Error("Import of an untracked file outside every directory: " + from);
  };
  const importers = new Map<string, Set<string>>();
  for (const file of files) {
    if (!isCode(file)) continue;
    for (const reference of sourceReferences(file, readFileSync(join(root, file), "utf8")))
      // Types are erased before anything runs; the fast job's typecheck covers their importers.
      for (const target of reference.kind === "type" ? [] : resolved(file, reference))
        if (target !== file) addTo(importers, target, file);
  }
  return { files: tracked, importers };
}
export type ImportGraph = ReturnType<typeof importGraph>;

/**
 * The paths themselves and everything the edges lead to from them, transitively. Over a graph's
 * `importers`, that is every file that imports or reads the paths.
 */
export function dependents(edges: ReadonlyMap<string, Iterable<string>>, paths: Iterable<string>) {
  const reached = new Set<string>();
  const pending = [...paths];
  while (pending.length) {
    const path = pending.pop()!;
    if (reached.has(path)) continue;
    reached.add(path);
    for (const next of edges.get(path) ?? []) pending.push(next);
  }
  return reached;
}
