import type TypeScript from "../../.upstream/node_modules/typescript-5/lib/typescript.d.ts";
import { createRequire } from "node:module";
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
  const ts = createRequire(join(root, ".upstream/package.json"))(
    "typescript-5",
  ) as typeof TypeScript;
  const tests: TestIdentity[] = [];
  const paths = codeFiles(join(root, ".upstream/e2e/tests")).filter((path) =>
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(path),
  );
  const program = ts.createProgram(paths, { noResolve: true, noLib: true, allowJs: true });
  const checker = program.getTypeChecker();
  for (const path of paths) {
    const file = path.slice(join(root, ".upstream/e2e/tests/").length);
    const source = program.getSourceFile(path)!;
    const references = (node: TypeScript.Node) => {
      const result = new Set<string>();
      const walk = (child: TypeScript.Node) => {
        if (
          ts.isPropertyAccessExpression(child) &&
          ts.isIdentifier(child.expression) &&
          child.expression.text === "scenarios"
        )
          result.add(child.name.text);
        ts.forEachChild(child, walk);
      };
      walk(node);
      return [...result];
    };
    const testNames = new Set(["it", "test"]);
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
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          if (["it", "test"].includes(binding.propertyName?.text ?? binding.name.text))
            testNames.add(binding.name.text);
    }
    const callName = (node: TypeScript.Node): string =>
      ts.isIdentifier(node)
        ? node.text
        : ts.isPropertyAccessExpression(node)
          ? `${callName(node.expression)}.${node.name.text}`
          : ts.isCallExpression(node)
            ? callName(node.expression)
            : "";
    let calls = 0;
    const visit = (node: TypeScript.Node) => {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (
          testNames.has(name.split(".")[0]!) &&
          (node.arguments.length >= 2 || name.endsWith(".todo"))
        ) {
          calls++;
          const title = node.arguments[0]!;
          const disabled = /\.(?:skip|todo|skipIf|runIf)(?:\.|$)/.test(name);
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
            for (
              let parent: TypeScript.Node | undefined = node.parent;
              parent;
              parent = parent.parent
            ) {
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
