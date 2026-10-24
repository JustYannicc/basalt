import ts from "typescript";
import type { StaticValues } from "./static-values.ts";

export interface RegexCaptureIdentity {
  symbol: ts.Symbol;
  index: number;
}

export const unwrap = (node: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))
    node = node.expression;
  return node;
};

export function isUndefined(expression: ts.Expression | undefined, values: StaticValues): boolean {
  if (!expression) return true;
  expression = unwrap(expression);
  return ts.isVoidExpression(expression) ||
    (ts.isIdentifier(expression) && expression.text === "undefined" && values.isUnshadowedGlobal(expression));
}

export function functionOf(call: ts.CallExpression, values: StaticValues): ts.FunctionLikeDeclaration | undefined {
  const symbol = values.symbolAt(call.expression);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)))
    return declaration.initializer;
  return undefined;
}

interface ReturnedExpression {
  expression: ts.Expression | undefined;
  direct: boolean;
}

function directReturnBlock(node: ts.Node, fn: ts.FunctionLikeDeclaration): ts.Block | undefined {
  if (node === fn.body && ts.isBlock(node)) return node;
  if (ts.isBlock(node) && ts.isTryStatement(node.parent) && node.parent.tryBlock === node && node.parent.parent === fn.body)
    return node;
  return undefined;
}

function returnedExpressions(fn: ts.FunctionLikeDeclaration): ReturnedExpression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [{ expression: fn.body, direct: true }];
  const expressions: ReturnedExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) expressions.push({ expression: node.expression, direct: !!directReturnBlock(node.parent, fn) });
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return expressions;
}

export function returnedProperty(fn: ts.FunctionLikeDeclaration, name: string, values: StaticValues): ts.Expression[] | undefined {
  const result: ts.Expression[] = [];
  for (const returned of returnedExpressions(fn)) {
    if (isUndefined(returned.expression, values)) continue;
    if (!returned.direct || !returned.expression || !ts.isObjectLiteralExpression(unwrap(returned.expression))) return undefined;
    const object = unwrap(returned.expression) as ts.ObjectLiteralExpression;
    if (object.properties.some(candidate => ts.isSpreadAssignment(candidate) ||
      (!ts.isSpreadAssignment(candidate) && ts.isComputedPropertyName(candidate.name)))) return undefined;
    const matches = object.properties.filter(candidate => !ts.isSpreadAssignment(candidate) &&
      (ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)) && candidate.name.text === name);
    if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0]!)) return undefined;
    const property = matches[0] as ts.PropertyAssignment;
    result.push(property.initializer);
  }
  return result.length > 0 ? result : undefined;
}

export function constInitializer(identifier: ts.Identifier, values: StaticValues): ts.Expression | undefined {
  const symbol = values.symbolAt(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer) return undefined;
  return declaration.initializer;
}

export function bindingMatch(identifier: ts.Identifier, values: StaticValues): { match: ts.Identifier; index: number } | undefined {
  const symbol = values.symbolAt(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isBindingElement(declaration) || !ts.isArrayBindingPattern(declaration.parent)) return undefined;
  const pattern = declaration.parent;
  const owner = pattern.parent;
  if (!ts.isVariableDeclaration(owner) || !(owner.parent.flags & ts.NodeFlags.Const) ||
    !owner.initializer || !ts.isIdentifier(owner.initializer)) return undefined;
  const index = pattern.elements.indexOf(declaration);
  return index < 0 ? undefined : { match: owner.initializer, index };
}

export function regexCaptureIdentity(expression: ts.Expression, values: StaticValues, seen = new Set<ts.Symbol>()): RegexCaptureIdentity | undefined {
  expression = unwrap(expression);
  if (ts.isTemplateExpression(expression) && expression.head.text === "/" && expression.templateSpans.length === 1 &&
    expression.templateSpans[0]!.literal.text === "")
    return regexCaptureIdentity(expression.templateSpans[0]!.expression, values, seen);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toLowerCase" && expression.arguments.length === 0)
    return regexCaptureIdentity(expression.expression.expression, values, seen);
  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
    expression.argumentExpression && ts.isNumericLiteral(expression.argumentExpression)) {
    const symbol = values.symbolAt(expression.expression);
    const index = Number(expression.argumentExpression.text);
    return symbol && Number.isSafeInteger(index) && index > 0 ? { symbol, index } : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const binding = bindingMatch(expression, values);
  if (binding) {
    const symbol = values.symbolAt(binding.match);
    return symbol ? { symbol, index: binding.index } : undefined;
  }
  const symbol = values.symbolAt(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  const initializer = constInitializer(expression, values);
  return initializer ? regexCaptureIdentity(initializer, values, new Set(seen).add(symbol)) : undefined;
}

function sameSymbol(left: ts.Identifier, right: ts.Identifier, values: StaticValues): boolean {
  return values.symbolAt(left) === values.symbolAt(right);
}

export function propertyOfUrl(expression: ts.Expression, url: ts.Identifier, values: StaticValues): string | undefined {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toLowerCase" && expression.arguments.length === 0)
    expression = unwrap(expression.expression.expression);
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression) ||
    !sameSymbol(expression.expression, url, values)) return undefined;
  return expression.name.text;
}

function rejectingUndefined(statement: ts.Statement, values: StaticValues): boolean {
  return ts.isReturnStatement(statement) && isUndefined(statement.expression, values);
}

function strictOrTerms(expression: ts.Expression): ts.BinaryExpression[] | undefined {
  expression = unwrap(expression);
  if (!ts.isBinaryExpression(expression)) return undefined;
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const left = strictOrTerms(expression.left);
    const right = strictOrTerms(expression.right);
    return left && right ? [...left, ...right] : undefined;
  }
  return expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ? [expression] : undefined;
}

export function dominatingGuard(fn: ts.FunctionLikeDeclaration, values: StaticValues): { index: number; terms: ts.BinaryExpression[] } | undefined {
  if (!fn.body || !ts.isBlock(fn.body)) return undefined;
  const scopes = [fn.body, ...fn.body.statements.flatMap(statement =>
    ts.isTryStatement(statement) ? [statement.tryBlock] : [])];
  const successfulReturns: ts.ReturnStatement[] = [];
  const findReturns = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && !isUndefined(node.expression, values)) successfulReturns.push(node);
    ts.forEachChild(node, findReturns);
  };
  findReturns(fn.body);
  for (const scope of scopes) {
    const scopedReturns = successfulReturns.filter(statement => statement.parent === scope);
    if (scopedReturns.length === 0 || scopedReturns.length !== successfulReturns.length) continue;
    for (let index = 0; index < scope.statements.length; index++) {
      const statement = scope.statements[index]!;
      if (!ts.isIfStatement(statement) || statement.elseStatement || !rejectingUndefined(statement.thenStatement, values)) continue;
      const terms = strictOrTerms(statement.expression);
      if (terms && scopedReturns.every(success => scope.statements.indexOf(success) > index)) return { index, terms };
    }
  }
  return undefined;
}

export function urlDeclaration(fn: ts.FunctionLikeDeclaration, argument: ts.Expression, values: StaticValues): ts.Identifier | undefined {
  const target = unwrap(argument);
  const argSymbol = ts.isIdentifier(target) ? values.symbolAt(target) : undefined;
  let match: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (match) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (!ts.isNewExpression(initializer) || !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== "URL" || !values.isUnshadowedGlobal(initializer.expression) ||
        !initializer.arguments?.length) { ts.forEachChild(node, visit); return; }
      const urlArgument = initializer.arguments[0]!;
      if ((ts.isIdentifier(urlArgument) && values.symbolAt(urlArgument) === argSymbol) ||
        (!argSymbol && urlArgument.getText() === argument.getText())) match = node.name;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return match;
}
