import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";

const apiSymbols = new Set(["defineApp", "mutation", "query", "QueryContext", "MutationContext"]);
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

function propertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (["Literal", "StringLiteral"].includes(node?.type)) return node.value;
  return undefined;
}

function unwrap(node) {
  while (
    node &&
    [
      "ChainExpression",
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "TSInstantiationExpression",
    ].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

function localName(specifier) {
  return propertyName(specifier?.local);
}

function exportedName(specifier) {
  return propertyName(specifier?.exported);
}

export function createModuleGraph(context, rootProgram) {
  const rootFile = resolve(context.cwd, context.filename);
  const programs = new Map([[rootFile, rootProgram]]);

  function isInsideRoot(file) {
    const fromRoot = relative(context.cwd, file);
    return (
      fromRoot !== "" &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(".." + sep) &&
      !isAbsolute(fromRoot)
    );
  }

  function resolveFile(importer, specifier) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
    const requested = resolve(dirname(importer), specifier);
    const extension = extname(requested);
    const candidates = [requested];
    if (extension) {
      if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
        const stem = requested.slice(0, -extension.length);
        candidates.push(...extensions.map((item) => stem + item));
      }
    } else {
      candidates.push(...extensions.map((item) => requested + item));
      candidates.push(...extensions.map((item) => resolve(requested, "index" + item)));
    }
    for (const candidate of candidates) {
      if (!isInsideRoot(candidate) || !existsSync(candidate)) continue;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        return null;
      }
    }
    return null;
  }

  function programAt(file) {
    if (programs.has(file)) return programs.get(file);
    try {
      const result = parseSync(file, readFileSync(file, "utf8"), { sourceType: "module" });
      const program = result.errors?.length ? null : result.program;
      programs.set(file, program);
      return program;
    } catch {
      programs.set(file, null);
      return null;
    }
  }

  function resolveFrom(source, name, importer, seen) {
    if (source === "apps") {
      if (name === "*") return "namespace";
      return apiSymbols.has(name) ? name : null;
    }
    const file = resolveFile(importer, source);
    return file ? resolveExport(file, name, seen) : null;
  }

  function resolveLocal(file, program, name, seen) {
    if (!program) return null;
    for (const statement of program.body ?? []) {
      if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
        for (const specifier of statement.specifiers ?? []) {
          if (specifier.local?.name !== name || specifier.importKind === "type") continue;
          if (specifier.type === "ImportNamespaceSpecifier")
            return resolveFrom(statement.source.value, "*", file, seen);
          const imported =
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : propertyName(specifier.imported);
          return resolveFrom(statement.source.value, imported, file, seen);
        }
      }

      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
      const declarator = declaration.declarations?.find(
        (item) => item.id?.type === "Identifier" && item.id.name === name,
      );
      if (declarator) return resolveExpression(declarator.init, file, seen);
    }
    return null;
  }

  function resolveExpression(expression, file, seen) {
    const node = unwrap(expression);
    if (node?.type === "Identifier") return resolveLocal(file, programAt(file), node.name, seen);
    if (node?.type !== "MemberExpression") return null;
    const base = resolveExpression(node.object, file, seen);
    const name = propertyName(node.property);
    if (base === "namespace") return apiSymbols.has(name) ? name : null;
    if (base?.kind === "namespace") return base.resolve(name);
    if (base === "unknown") return "unknown";
    return null;
  }

  function resolveNamespace(file, seen) {
    return { kind: "namespace", resolve: (name) => resolveExport(file, name, seen) };
  }

  function resolveExport(file, name, seen = new Set()) {
    if (name === "*") return resolveNamespace(file, seen);
    const key = file + "\0" + name;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const program = programAt(file);
    if (!program) return null;
    const stars = [];

    for (const statement of program.body ?? []) {
      if (statement.type === "ExportDefaultDeclaration" && name === "default")
        return resolveExpression(statement.declaration, file, nextSeen);

      if (statement.type === "ExportNamedDeclaration") {
        if (statement.exportKind === "type") continue;
        for (const specifier of statement.specifiers ?? []) {
          if (exportedName(specifier) !== name || specifier.exportKind === "type") continue;
          const local = localName(specifier);
          if (statement.source) return resolveFrom(statement.source.value, local, file, nextSeen);
          return resolveLocal(file, program, local, nextSeen);
        }
        const declaration = statement.declaration;
        if (declaration?.type === "VariableDeclaration") {
          const value = declaration.declarations?.find(
            (item) => item.id?.type === "Identifier" && item.id.name === name,
          );
          if (value) {
            const symbol = resolveExpression(value.init, file, nextSeen);
            return declaration.kind === "const" ? symbol : symbol ? "unknown" : null;
          }
        } else if (declaration?.id?.name === name) return null;
      }

      if (statement.type === "ExportAllDeclaration" && statement.source) {
        if (statement.exported) {
          if (exportedName(statement) === name)
            return resolveFrom(statement.source.value, "*", file, nextSeen);
        } else if (name !== "default") {
          stars.push(resolveFrom(statement.source.value, name, file, nextSeen));
        }
      }
    }

    const matches = [...new Set(stars.filter(Boolean))];
    if (matches.length === 1) return matches[0];
    return matches.length > 1 ? "unknown" : null;
  }

  return {
    resolveExport: (source, name) => resolveFrom(source, name, rootFile, new Set()),
  };
}
