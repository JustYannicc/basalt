import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { filesBelow } from "./files.ts";

// A code, or a code family (`home-schema-*`) whose tail is computed at runtime.
const code = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*(?:-[a-z0-9_]+|-\*)$/;
type Callable = ts.FunctionLikeDeclaration;

/**
 * Every refusal code a release can raise, read from the source. A code reaches `BarrierRefusal`
 * directly, through helpers that forward their first parameter (`classConstraint` → `classRefusal`),
 * through a subclass's `super(...)`, or as a computed reason (`refusal?.reason ?? "code"`, a ternary,
 * or a local whose initializer chooses the code). All four shapes failed in production.
 */
export function barrierRefusalCodes(root: string) {
  const files = releaseSources(root).map((path) =>
    ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true),
  );
  const sinks = new Set(["BarrierRefusal"]);
  const subclasses = new Set<ts.ClassLikeDeclaration>();
  for (let grew = true; grew;) {
    grew = false;
    for (const file of files)
      visit(file, (node) => {
        if (ts.isClassLike(node) && node.name && !sinks.has(node.name.text) && extendsSink(node)) {
          subclasses.add(node);
          const constructor = node.members.find(ts.isConstructorDeclaration);
          const first = constructor?.parameters[0]?.name;
          // A subclass whose first parameter is the reason is itself a place codes are passed to.
          if (
            !constructor ||
            (first && ts.isIdentifier(first) && forwards(constructor, first.text, ["super"]))
          ) {
            sinks.add(node.name.text);
            grew = true;
          }
        }
        const name = callableName(node);
        if (!name || sinks.has(name)) return;
        const first = (node as Callable).parameters[0]?.name;
        if (first && ts.isIdentifier(first) && forwards(node as Callable, first.text, [...sinks])) {
          sinks.add(name);
          grew = true;
        }
      });
  }
  properties.clear();
  for (const file of files.filter((file) => /\bBarrierRefusal\b/.test(file.text)))
    visit(file, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        ts.isStringLiteralLike(node.initializer)
      )
        properties.set(node.name.text, [
          ...(properties.get(node.name.text) ?? []),
          node.initializer.text,
        ]);
    });
  const codes = new Set<string>();
  for (const file of files) {
    const refuses = /\bBarrierRefusal\b/.test(file.text);
    visit(file, (node) => {
      const reason =
        sinkReason(node, sinks, subclasses) ?? (refuses ? planReason(node) : undefined);
      if (reason)
        for (const value of literals(reason, file)) if (code.test(value)) codes.add(value);
    });
  }
  return [...codes].sort();

  function extendsSink(node: ts.ClassLikeDeclaration) {
    return (node.heritageClauses ?? []).some((clause) =>
      clause.types.some(
        (type) => ts.isIdentifier(type.expression) && sinks.has(type.expression.text),
      ),
    );
  }
}

const properties = new Map<string, string[]>();
const propertyValues = (name: string) => properties.get(name) ?? [];

function sinkReason(
  node: ts.Node,
  sinks: Set<string>,
  subclasses: Set<ts.ClassLikeDeclaration>,
): ts.Expression | undefined {
  if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.length) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && sinks.has(callee.text)) return node.arguments[0];
    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      const owner = ts.findAncestor(node, ts.isClassLike);
      if (owner && subclasses.has(owner)) return node.arguments[0];
    }
  }
  return undefined;
}

function forwards(callable: Callable, parameter: string, sinks: readonly string[]) {
  let found = false;
  visit(callable, (node) => {
    if (found || !(ts.isCallExpression(node) || ts.isNewExpression(node))) return;
    const callee = node.expression;
    const name =
      callee.kind === ts.SyntaxKind.SuperKeyword
        ? "super"
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
    const first = node.arguments?.[0];
    if (name && sinks.includes(name) && first && mentions(first, parameter)) found = true;
  });
  // A plan refusal (`{ reason, fqn, ... }`) carries its code into BarrierRefusal's refusal list.
  visit(callable, (node) => {
    const value = planReason(node);
    if (value && mentions(value, parameter)) found = true;
  });
  return found;
}

function planReason(node: ts.Node) {
  if (ts.isShorthandPropertyAssignment(node) && node.name.text === "reason") return node.name;
  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "reason" &&
    ts.isObjectLiteralExpression(node.parent)
  )
    return node.initializer;
  return undefined;
}

function mentions(expression: ts.Node, name: string): boolean {
  if (ts.isIdentifier(expression) && expression.text === name) return true;
  return ts.forEachChild(expression, (child) => mentions(child, name) || undefined) ?? false;
}

/** String literals the reason can evaluate to, following locals to their initializers. */
function literals(expression: ts.Node, file: ts.SourceFile, seen = new Set<string>()): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  // `home-schema-${reason}` raises a family of codes; its fixed head names the family.
  if (ts.isTemplateExpression(expression)) return [`${expression.head.text}*`];
  // `refusals.refused` names a code that callers supply as `{ refused: "..." }`.
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
    return [
      ...propertyValues(expression.name.text),
      ...literals(expression.expression, file, seen),
    ];
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return [];
    seen.add(expression.text);
    const values: string[] = [];
    visit(file, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === expression.text &&
        node.initializer
      )
        values.push(...literals(node.initializer, file, seen));
    });
    return values;
  }
  // A call's arguments are its inputs, not the reason it returns.
  if (ts.isCallExpression(expression)) return [];
  const values: string[] = [];
  ts.forEachChild(expression, (child) => {
    values.push(...literals(child, file, seen));
  });
  return values;
}

function callableName(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  )
    return node.parent.name.text;
  return undefined;
}

function visit(node: ts.Node, each: (node: ts.Node) => void) {
  each(node);
  ts.forEachChild(node, (child) => visit(child, each));
}

function releaseSources(root: string) {
  const directory = join(root, "scripts");
  return filesBelow(directory).filter(
    (path) =>
      /\.(?:ts|mjs)$/.test(path) &&
      !/\.test\.(?:ts|mjs)$/.test(path) &&
      !relative(directory, path).split("/").includes("test") &&
      // The generated LikeC4 model is large, gitignored and holds no release code.
      !relative(directory, path).startsWith("architecture/gen/"),
  );
}
