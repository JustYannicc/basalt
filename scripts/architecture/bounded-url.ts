import ts from "typescript";
import type { StaticValues } from "./static-values.ts";
import {
  bindingMatch, constInitializer, dominatingGuard, functionOf, propertyOfUrl,
  regexCaptureIdentity, returnedProperty, unwrap, urlDeclaration,
} from "./bounded-url-ast.ts";
import type { RegexCaptureIdentity } from "./bounded-url-ast.ts";

interface RegexCapture {
  pattern: string;
  start: number;
  end: number;
}

function regexBody(literal: ts.RegularExpressionLiteral): string | undefined {
  const source = literal.text;
  let escaped = false, inClass = false, close = -1;
  for (let index = 1; index < source.length; index++) {
    const character = source[index]!;
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "[" && !inClass) { inClass = true; continue; }
    if (character === "]" && inClass) { inClass = false; continue; }
    if (character === "/" && !inClass) close = index;
  }
  return source.startsWith("/") && close > 0 && /^[dgimsuvy]*$/.test(source.slice(close + 1))
    ? source.slice(1, close) : undefined;
}

function captureAt(body: string, wanted: number): RegexCapture | undefined {
  const captures: RegexCapture[] = [];
  const stack: number[] = [];
  let escaped = false, inClass = false;
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "[" && !inClass) { inClass = true; continue; }
    if (character === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (character === "(") {
      const named = body[index + 1] === "?" && body[index + 2] === "<" &&
        !["=", "!"].includes(body[index + 3] ?? "");
      const capturing = body[index + 1] !== "?" || named;
      const start = named ? body.indexOf(">", index + 3) + 1 : index + 1;
      if (named && start <= index + 3) return undefined;
      if (capturing) captures.push({ pattern: "", start, end: -1 });
      stack.push(capturing ? captures.length : 0);
    } else if (character === ")") {
      const capture = stack.pop();
      if (capture === undefined) return undefined;
      if (capture) captures[capture - 1]!.end = index;
    }
  }
  const capture = captures[wanted - 1];
  return !capture || capture.end < capture.start
    ? undefined
    : { ...capture, pattern: body.slice(capture.start, capture.end) };
}

function boundedHostPattern(pattern: string): string | undefined {
  const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
  if (!pattern.startsWith(label)) return undefined;
  const suffix = pattern.slice(label.length);
  if (!/^(?:\\\.[A-Za-z0-9-]+)+$/.test(suffix)) return undefined;
  const hostSuffix = suffix.replaceAll("\\.", ".");
  if (hostSuffix.slice(1).split(".").some(part =>
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) return undefined;
  return `*${hostSuffix}`;
}

function regexCapturePatternFromMatch(match: ts.Identifier, index: number, fn: ts.FunctionLikeDeclaration, values: StaticValues): string | undefined {
  if (!Number.isSafeInteger(index) || index < 1) return undefined;
  const initializer = constInitializer(match, values);
  if (!initializer || !ts.isCallExpression(unwrap(initializer))) return undefined;
  const exec = unwrap(initializer) as ts.CallExpression;
  if (!ts.isPropertyAccessExpression(exec.expression) || exec.expression.name.text !== "exec" ||
    !ts.isRegularExpressionLiteral(unwrap(exec.expression.expression)) || exec.arguments.length !== 1) return undefined;
  const body = regexBody(unwrap(exec.expression.expression) as ts.RegularExpressionLiteral);
  const capture = body && captureAt(body, index);
  if (!body?.startsWith("^https:\\/\\/") || !body.endsWith("$") || !capture ||
    !body.slice(0, capture.start - 1).endsWith("@") || !body.slice(capture.end + 1).startsWith("\\/")) return undefined;
  const url = urlDeclaration(fn, unwrap(exec.arguments[0]!), values);
  if (!url || values.isMutated(url)) return undefined;
  const candidateHost = boundedHostPattern(capture.pattern);
  const matchSymbol = values.symbolAt(match);
  const identity = matchSymbol ? { symbol: matchSymbol, index } : undefined;
  return candidateHost && identity && hasUrlGuards(fn, url, candidateHost, values, fn, true, identity)
    ? candidateHost : undefined;
}

function regexCapturePattern(expression: ts.Expression, fn: ts.FunctionLikeDeclaration, values: StaticValues): string | undefined {
  expression = unwrap(expression);
  if (!ts.isElementAccessExpression(expression) || !ts.isIdentifier(expression.expression) ||
    !expression.argumentExpression || !ts.isNumericLiteral(expression.argumentExpression)) return undefined;
  return regexCapturePatternFromMatch(expression.expression, Number(expression.argumentExpression.text), fn, values);
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) || ts.isConstructorDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent))
      return parent;
  return undefined;
}

function trustedHost(
  expression: ts.Expression,
  values: StaticValues,
  seenSymbols = new Set<ts.Symbol>(),
  seenFunctions = new Set<ts.FunctionLikeDeclaration>(),
): string | undefined {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toLowerCase" && expression.arguments.length === 0)
    return trustedHost(expression.expression.expression, values, seenSymbols, seenFunctions);
  if (ts.isElementAccessExpression(expression)) {
    const fn = enclosingFunction(expression);
    return fn && regexCapturePattern(expression, fn, values);
  }
  if (ts.isIdentifier(expression)) {
    const binding = bindingMatch(expression, values);
    if (binding) {
      const fn = enclosingFunction(expression);
      return fn ? regexCapturePatternFromMatch(binding.match, binding.index, fn, values) : undefined;
    }
    const symbol = values.symbolAt(expression);
    if (!symbol || seenSymbols.has(symbol)) return undefined;
    const initializer = constInitializer(expression, values);
    return initializer ? trustedHost(initializer, values, new Set(seenSymbols).add(symbol), seenFunctions) : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "host" || !ts.isIdentifier(expression.expression))
    return undefined;
  const symbol = values.symbolAt(expression.expression);
  if (!symbol || seenSymbols.has(symbol) || values.isMutated(expression.expression)) return undefined;
  const initializer = constInitializer(expression.expression, values);
  if (!initializer || !ts.isCallExpression(unwrap(initializer))) return undefined;
  const fn = functionOf(unwrap(initializer) as ts.CallExpression, values);
  if (!fn || seenFunctions.has(fn)) return undefined;
  const returned = returnedProperty(fn, "host", values);
  if (!returned) return undefined;
  const nextFunctions = new Set(seenFunctions).add(fn);
  const hosts = returned.map(value => trustedHost(value, values, new Set(seenSymbols).add(symbol), nextFunctions));
  return hosts[0] && hosts.every(host => host === hosts[0]) ? hosts[0] : undefined;
}

function rawRegexPattern(expression: ts.Expression, values: StaticValues, seen = new Set<ts.Symbol>()): string | undefined {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toLowerCase" && expression.arguments.length === 0)
    return rawRegexPattern(expression.expression.expression, values, seen);
  if (ts.isIdentifier(expression)) {
    const binding = bindingMatch(expression, values);
    const match = binding?.match ?? expression;
    const index = binding?.index;
    if (index !== undefined || ts.isIdentifier(expression)) {
      const initializer = constInitializer(match, values);
      if (initializer && ts.isCallExpression(unwrap(initializer))) {
        const exec = unwrap(initializer) as ts.CallExpression;
        if (ts.isPropertyAccessExpression(exec.expression) && exec.expression.name.text === "exec" &&
          ts.isRegularExpressionLiteral(unwrap(exec.expression.expression))) {
          const body = regexBody(unwrap(exec.expression.expression) as ts.RegularExpressionLiteral);
          const captureIndex = index ?? Number(unwrap(expression).getText());
          if (Number.isSafeInteger(captureIndex) && captureIndex > 0)
            return body ? captureAt(body, captureIndex)?.pattern : undefined;
        }
      }
    }
    const symbol = values.symbolAt(expression);
    if (!symbol || seen.has(symbol)) return undefined;
    const initializer = constInitializer(expression, values);
    return initializer ? rawRegexPattern(initializer, values, new Set(seen).add(symbol)) : undefined;
  }
  if (!ts.isElementAccessExpression(expression) || !ts.isIdentifier(expression.expression) ||
    !expression.argumentExpression || !ts.isNumericLiteral(expression.argumentExpression)) return undefined;
  const initializer = constInitializer(expression.expression, values);
  if (!initializer || !ts.isCallExpression(unwrap(initializer))) return undefined;
  const exec = unwrap(initializer) as ts.CallExpression;
  if (!ts.isPropertyAccessExpression(exec.expression) || exec.expression.name.text !== "exec" ||
    !ts.isRegularExpressionLiteral(unwrap(exec.expression.expression))) return undefined;
  const body = regexBody(unwrap(exec.expression.expression) as ts.RegularExpressionLiteral);
  return body ? captureAt(body, Number(expression.argumentExpression.text))?.pattern : undefined;
}

function hasUrlGuards(
  fn: ts.FunctionLikeDeclaration,
  url: ts.Identifier,
  expectedHost: string,
  values: StaticValues,
  proofFunction: ts.FunctionLikeDeclaration,
  allowDsnUsername = false,
  expectedCapture?: RegexCaptureIdentity,
): boolean {
  const guard = dominatingGuard(fn, values);
  if (!guard) return false;
  const fields = new Set<string>();
  for (const comparison of guard.terms) {
    const field = propertyOfUrl(comparison.left, url, values);
    if (!field || fields.has(field)) return false;
    const right = unwrap(comparison.right);
    const literal = ts.isStringLiteralLike(right) ? right.text : undefined;
    if (field === "protocol" && literal === "https:") fields.add(field);
    else if (["password", "port", "search", "hash"].includes(field) && literal === "") fields.add(field);
    else if (field === "username" && (literal === "" || (allowDsnUsername && expectedCapture &&
      regexCaptureIdentity(right, values)?.symbol === expectedCapture.symbol &&
      regexCaptureIdentity(right, values)?.index === 1 && rawRegexPattern(right, values) === "[A-Za-z0-9_-]+"))) fields.add(field);
    else if (field === "pathname" && allowDsnUsername && expectedCapture &&
      regexCaptureIdentity(right, values)?.symbol === expectedCapture.symbol &&
      regexCaptureIdentity(right, values)?.index === 3) fields.add(field);
    else if (field === "hostname") {
      const rawHost = boundedHostPattern(rawRegexPattern(right, values) ?? "");
      const identity = regexCaptureIdentity(right, values);
      const comparedHost = expectedCapture
        ? rawHost === expectedHost && identity?.symbol === expectedCapture.symbol && identity.index === expectedCapture.index
        : trustedHost(right, values, new Set(), new Set([proofFunction])) === expectedHost;
      if (comparedHost) fields.add(field);
    } else return false;
  }
  return ["protocol", "hostname", "username", "password", "port", "search", "hash"].every(field => fields.has(field));
}

function boundedHostFromDsn(expression: ts.Expression, values: StaticValues, seen = new Set<ts.FunctionLikeDeclaration>()): string | undefined {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toLowerCase" && expression.arguments.length === 0)
    return boundedHostFromDsn(expression.expression.expression, values, seen);
  if (ts.isTemplateExpression(expression)) {
    if (expression.head.text !== "https://" || expression.templateSpans.length === 0) return undefined;
    const first = expression.templateSpans[0]!;
    return first.literal.text.startsWith("/") ? trustedHost(first.expression, values, new Set(), seen) : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "href" || !ts.isIdentifier(expression.expression)) return undefined;
  const url = expression.expression;
  if (values.isMutated(url)) return undefined;
  const initializer = constInitializer(url, values);
  const fn = enclosingFunction(url);
  if (!initializer || !fn || !ts.isNewExpression(unwrap(initializer))) return undefined;
  const newUrl = unwrap(initializer) as ts.NewExpression;
  if (!ts.isIdentifier(newUrl.expression) || newUrl.expression.text !== "URL" ||
    !values.isUnshadowedGlobal(newUrl.expression) || !newUrl.arguments?.length) return undefined;
  const hostComparison = dominatingGuard(fn, values)?.terms.find(comparison => propertyOfUrl(comparison.left, url, values) === "hostname");
  const host = hostComparison && trustedHost(hostComparison.right, values, new Set(), seen);
  return host && hasUrlGuards(fn, url, host, values, fn) ? host : undefined;
}

function boundedHostFromTarget(expression: ts.Expression, values: StaticValues, seen = new Set<ts.FunctionLikeDeclaration>()): string | undefined {
  expression = unwrap(expression);
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "url" || !ts.isIdentifier(expression.expression))
    return boundedHostFromDsn(expression, values, seen);
  const target = expression.expression;
  if (values.isMutated(target)) return undefined;
  const initializer = constInitializer(target, values);
  if (!initializer || !ts.isCallExpression(unwrap(initializer))) return undefined;
  const fn = functionOf(unwrap(initializer) as ts.CallExpression, values);
  if (!fn || seen.has(fn)) return undefined;
  const returned = returnedProperty(fn, "url", values);
  if (!returned) return undefined;
  const next = new Set(seen).add(fn);
  const hosts = returned.map(value => boundedHostFromDsn(value, values, next));
  return hosts[0] && hosts.every(host => host === hosts[0]) ? hosts[0] : undefined;
}

/** Prove a URL host only when the owned AST validates it against a fixed DNS suffix. */
export function boundedUrlHost(expression: ts.Expression, values: StaticValues): string | undefined {
  return boundedHostFromTarget(expression, values);
}
