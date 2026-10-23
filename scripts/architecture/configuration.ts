import ts from "typescript";

export interface ConfigurationIssue {
  node: ts.Node;
  message: string;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) expression = expression.expression;
  return expression;
}

function literal(expression: ts.Expression): boolean {
  expression = unwrap(expression);
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) return true;
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.every(element => !ts.isSpreadElement(element) && literal(element));
  if (ts.isObjectLiteralExpression(expression))
    return expression.properties.every(property =>
      ts.isPropertyAssignment(property) &&
      !ts.isComputedPropertyName(property.name) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) &&
      literal(property.initializer));
  return false;
}

/** Configuration modules are data declarations. Their URL values never imply a network edge. */
export function configurationIssues(source: ts.SourceFile): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  let declarations = 0;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) {
      issues.push({ node: statement, message: "Configuration modules allow only literal const declarations" });
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      declarations += 1;
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !literal(declaration.initializer))
        issues.push({ node: declaration, message: "Configuration modules allow only literal const declarations" });
    }
  }
  if (declarations === 0 && issues.length === 0)
    issues.push({ node: source, message: "Configuration modules need literal const declarations" });
  return issues;
}
