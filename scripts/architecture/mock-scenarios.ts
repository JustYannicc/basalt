import ts from "typescript";

const propertyName = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
const properties = (node: ts.Node | undefined) =>
  new Map(
    node && ts.isObjectLiteralExpression(node)
      ? node.properties.flatMap((property) =>
          ts.isPropertyAssignment(property)
            ? [[propertyName(property.name), property.initializer] as const]
            : [],
        )
      : [],
  );

export function declaredScenarios(source: string) {
  const file = ts.createSourceFile("test-plan.ts", source, ts.ScriptTarget.Latest, true);
  const scenarios = new Map<string, { file: string; title: string; targets: string[] }>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "scenarios" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(file) === "plan"
    ) {
      for (const [key, entry] of properties(node.initializer.arguments[0])) {
        const fields = properties(entry),
          path = fields.get("file"),
          title = fields.get("title");
        if (key && path && title && ts.isStringLiteral(path) && ts.isStringLiteral(title))
          scenarios.set(key, {
            file: path.text,
            title: title.text,
            targets: [...properties(fields.get("targets"))].flatMap(([target, value]) =>
              target && ts.isIdentifier(value) && value.text === "scheduled" ? [target] : [],
            ),
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return scenarios;
}

// Only registrations directly evaluated by the module or a supported synchronous
// suite callback count. Traversing arbitrary function bodies invents execution.
export function implementsScenario(source: string, key: string) {
  const file = ts.createSourceFile("scenario.ts", source, ts.ScriptTarget.Latest, true);
  const inspect = (statements: ts.NodeArray<ts.Statement>): boolean => {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
        continue;
      const call = statement.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "effect" &&
        call.expression.expression.getText(file) === "it" &&
        call.arguments.length >= 2 &&
        call.arguments[0]!.getText(file) === `scenarios.${key}.title` &&
        (ts.isArrowFunction(call.arguments[1]!) || ts.isFunctionExpression(call.arguments[1]!))
      )
        return true;
      const suite =
        call.expression.getText(file) === "describe" ||
        (ts.isCallExpression(call.expression) &&
          call.expression.expression.getText(file) === "layer");
      const callback = call.arguments[1];
      if (
        !suite ||
        !callback ||
        (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
        callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
        (ts.isFunctionExpression(callback) && callback.asteriskToken) ||
        !ts.isBlock(callback.body)
      )
        continue;
      // Control flow in a registration scope needs a dedicated verifier. A return
      // or conditional before a test can prevent registration altogether.
      if (
        callback.body.statements.some(
          (child) =>
            !ts.isExpressionStatement(child) &&
            !ts.isVariableStatement(child) &&
            !ts.isFunctionDeclaration(child),
        )
      )
        continue;
      if (inspect(callback.body.statements)) return true;
    }
    return false;
  };
  return inspect(file.statements);
}
