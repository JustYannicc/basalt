import ts from "../architecture/typescript.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const codeFiles = (directory: string) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

export type Plan = { file: string; title: string };
export type TestIdentity = {
  id: string;
  file: string;
  key?: string;
  title?: string;
  plan?: Plan;
  disabled?: boolean;
};

export function testInventory(root: string, plans: Record<string, Plan>) {
  const tests: TestIdentity[] = [];
  const paths = codeFiles(join(root, ".upstream/e2e/tests")).filter((path) =>
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(path),
  );
  const program = ts.createProgram(paths, { noResolve: true, noLib: true, allowJs: true });
  const checker = program.getTypeChecker();
  for (const path of paths) {
    const file = path.slice(join(root, ".upstream/e2e/tests/").length);
    const source = program.getSourceFile(path)!;
    const references = (node: ts.Node, seen = new Set<ts.Node>()): string[] => {
      if (seen.has(node)) return [];
      seen.add(node);
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
        return references(node.expression, seen);
      if (ts.isPropertyAccessExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === "scenarios")
          return [node.name.text];
        if (node.name.text === "title") return references(node.expression, seen);
      }
      if (ts.isConditionalExpression(node)) {
        const yes = references(node.whenTrue, seen),
          no = references(node.whenFalse, seen);
        return yes.length && no.length ? [...yes, ...no] : [];
      }
      if (ts.isElementAccessExpression(node) && ts.isObjectLiteralExpression(node.expression))
        return node.expression.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) ? references(property.initializer, seen) : [],
        );
      if (ts.isArrayLiteralExpression(node))
        return node.elements.flatMap((element) => references(element, seen));
      if (ts.isObjectLiteralExpression(node))
        return node.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === "scenario"
            ? references(property.initializer, seen)
            : [],
        );
      if (ts.isIdentifier(node))
        return (checker.getSymbolAtLocation(node)?.declarations ?? []).flatMap((declaration) =>
          ts.isVariableDeclaration(declaration) && declaration.initializer
            ? references(declaration.initializer, seen)
            : [],
        );
      return [];
    };
    const testNames = new Set(["it", "test"]);
    const suiteNames = new Set(["describe", "suite"]);
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !["vitest", "node:test", "@effect/vitest"].includes(statement.moduleSpecifier.text)
      )
        continue;
      const clause = statement.importClause;
      if (clause?.name && statement.moduleSpecifier.text === "node:test")
        testNames.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        for (const name of ["it", "test"]) testNames.add(`${bindings.name.text}.${name}`);
        for (const name of ["describe", "suite"]) suiteNames.add(`${bindings.name.text}.${name}`);
      }
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          if (["it", "test"].includes(binding.propertyName?.text ?? binding.name.text))
            testNames.add(binding.name.text);
          else if (["describe", "suite"].includes(binding.propertyName?.text ?? binding.name.text))
            suiteNames.add(binding.name.text);
    }
    const callName = (node: ts.Node, seen = new Set<ts.Node>()): string => {
      if (seen.has(node)) return "";
      seen.add(node);
      if (ts.isIdentifier(node)) {
        for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
          if (ts.isVariableDeclaration(declaration) && declaration.initializer)
            return callName(declaration.initializer, seen);
          if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
            const variable = declaration.parent.parent;
            if (ts.isVariableDeclaration(variable) && variable.initializer)
              return `${callName(variable.initializer, seen)}.${declaration.propertyName?.getText(source) ?? node.text}`;
          }
        }
        return node.text;
      }
      if (ts.isPropertyAccessExpression(node))
        return `${callName(node.expression, seen)}.${node.name.text}`;
      return ts.isCallExpression(node) ? callName(node.expression, seen) : "";
    };
    const belongsTo = (name: string, names: Set<string>) =>
      [...names].some((root) => name === root || name.startsWith(root + "."));
    const skipped = (name: string) => /\.(?:skip|todo|skipIf|runIf)(?:\.|$)/.test(name);
    let calls = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (belongsTo(name, testNames) && (node.arguments.length >= 2 || name.endsWith(".todo"))) {
          calls++;
          const title = node.arguments[0]!;
          let disabled = skipped(name);
          for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (ts.isCallExpression(parent)) {
              const ancestor = callName(parent.expression);
              if (belongsTo(ancestor, suiteNames) && skipped(ancestor)) disabled = true;
            }
          }
          let keys =
            ts.isPropertyAccessExpression(title) && title.name.text === "title"
              ? references(title)
              : [];
          if (
            !keys.length &&
            ts.isPropertyAccessExpression(title) &&
            ts.isIdentifier(title.expression)
          ) {
            for (const declaration of checker.getSymbolAtLocation(title.expression)?.declarations ??
              [])
              if (ts.isVariableDeclaration(declaration) && declaration.initializer)
                keys.push(...references(declaration.initializer));
          }
          if (!keys.length && ts.isPropertyAccessExpression(title) && title.name.text === "title") {
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (ts.isForOfStatement(parent)) {
                keys = references(parent.expression);
                if (!keys.length && ts.isIdentifier(parent.expression))
                  for (const declaration of checker.getSymbolAtLocation(parent.expression)
                    ?.declarations ?? [])
                    if (ts.isVariableDeclaration(declaration) && declaration.initializer)
                      keys.push(...references(declaration.initializer));
                if (keys.length) break;
              }
            }
          }
          if (keys.length) {
            for (const key of keys) {
              const plan = plans[key];
              tests.push({ id: `${file}#${key}`, file, key, title: plan?.title, plan, disabled });
            }
          } else if (ts.isStringLiteralLike(title)) {
            tests.push({ id: `${file}#${title.text}`, file, title: title.text, disabled });
          } else {
            tests.push({ id: `${file}#<dynamic: ${title.getText(source)}>`, file, disabled });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!calls) tests.push({ id: `${file}#<dynamic tests>`, file });
  }
  return tests;
}
