import { dirname, resolve } from "node:path";
import ts from "typescript";

type StaticValue =
  | { kind: "text"; prefix: string; complete: boolean }
  | { kind: "package"; specifier: string }
  | { kind: "unknown" };

const unknown: StaticValue = { kind: "unknown" };
const text = (prefix: string, complete = true): StaticValue => ({ kind: "text", prefix, complete });

function safePackagePath(value: StaticValue): boolean {
  if (value.kind !== "text" || !value.prefix || /^[\\/]/.test(value.prefix) || value.prefix.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(value.prefix)) return false;
  const path = value.prefix.split(/[?#]/, 1)[0]!;
  try { return !path.split("/").some(segment => decodeURIComponent(segment) === ".."); }
  catch { return false; }
}

function scriptExtension(path: string): ts.Extension {
  if (path.endsWith(".tsx")) return ts.Extension.Tsx;
  if (path.endsWith(".jsx")) return ts.Extension.Jsx;
  if (path.endsWith(".mjs")) return ts.Extension.Mjs;
  if (path.endsWith(".cjs")) return ts.Extension.Cjs;
  if (path.endsWith(".js")) return ts.Extension.Js;
  return ts.Extension.Ts;
}

function sourceCandidates(path: string): string[] {
  const resolved = path.replace(/\.m?js$/, ".ts").replace(/\.cjs$/, ".cts");
  return [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`,
    resolve(resolved, "index.ts"), resolve(resolved, "index.tsx"), resolve(resolved, "index.js")];
}

function combine(left: StaticValue, right: StaticValue): StaticValue {
  if (left.kind === "package" && right.kind === "text")
    return { kind: "package", specifier: `${left.specifier}${right.prefix}` };
  if (left.kind === "text" && right.kind === "unknown") return text(left.prefix, false);
  if (left.kind === "unknown" && right.kind === "text") return text("", false);
  if (left.kind !== "text" || right.kind !== "text") return unknown;
  if (!left.complete) return text(left.prefix, false);
  return text(`${left.prefix}${right.prefix}`, right.complete);
}

function assignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function authorityMutation(name: string): boolean {
  return ["host", "hostname", "protocol", "port", "username", "password"].includes(name);
}

/** Reads a closed set of parsed source files. It never evaluates or imports the inspected program. */
export class StaticValues {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly files: Map<string, string>;
  private readonly mutated = new Set<ts.Symbol>();
  private readonly aliases = new Map<ts.Symbol, ts.Symbol>();

  constructor(paths: readonly string[]) {
    this.files = new Map(paths.map(path => [resolve(path), ""]));
    const options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.Latest,
    };
    const host = ts.createCompilerHost(options, true);
    const baseFileExists = host.fileExists.bind(host);
    const baseReadFile = host.readFile.bind(host);
    host.fileExists = path => this.files.has(resolve(path)) || baseFileExists(path);
    host.readFile = path => this.files.has(resolve(path)) ? undefined : baseReadFile(path);
    host.getSourceFile = (path, languageVersion) => {
      const normalized = resolve(path);
      if (!this.files.has(normalized)) return undefined;
      const contents = baseReadFile(normalized);
      if (contents === undefined) return undefined;
      const kind = normalized.endsWith(".tsx") ? ts.ScriptKind.TSX :
        /\.[cm]?jsx?$/.test(normalized) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      return ts.createSourceFile(normalized, contents, languageVersion, true, kind);
    };
    host.resolveModuleNames = (names, containingFile) => names.map(name => {
      if (!name.startsWith(".")) return undefined;
      const target = sourceCandidates(resolve(dirname(containingFile), name)).find(path => this.files.has(path));
      return target ? { resolvedFileName: target, extension: scriptExtension(target), isExternalLibraryImport: false } : undefined;
    });
    this.program = ts.createProgram([...this.files.keys()], options, host);
    this.checker = this.program.getTypeChecker();
    this.collectAliases();
    this.collectMutations();
  }

  source(path: string): ts.SourceFile | undefined {
    return this.program.getSourceFile(resolve(path));
  }

  isUnshadowedGlobal(identifier: ts.Identifier): boolean {
    return this.checker.getSymbolAtLocation(identifier) === undefined;
  }

  urlHost(expression: ts.Expression): string | undefined {
    const value = this.value(expression, new Set());
    if (value.kind !== "text") return undefined;
    const prefix = value.prefix;
    const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(prefix);
    if (!scheme) return undefined;
    const authority = prefix.slice(scheme[0].length).search(/[/?#]/);
    if (!value.complete && authority < 0) return undefined;
    try {
      const parsed = new URL(value.complete ? prefix : prefix.slice(0, scheme[0].length + authority + 1));
      return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) && parsed.hostname
        ? parsed.hostname
        : undefined;
    } catch {
      return undefined;
    }
  }

  moduleSpecifier(expression: ts.Expression): string | undefined {
    const value = this.value(expression, new Set());
    if (value.kind === "package") return value.specifier;
    return value.kind === "text" && value.complete ? value.prefix : undefined;
  }

  packageSpecifier(expression: ts.Expression): boolean {
    return this.value(expression, new Set()).kind === "package";
  }

  private symbolAt(node: ts.Node): ts.Symbol | undefined {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try { symbol = this.checker.getAliasedSymbol(symbol); }
      catch { return undefined; }
    }
    return symbol;
  }

  private symbolValue(symbol: ts.Symbol, seen: Set<ts.Symbol>): StaticValue {
    if (this.mutated.has(symbol) || seen.has(symbol)) return unknown;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return unknown;
    const nested = new Set(seen).add(symbol);
    if (ts.isVariableDeclaration(declaration)) {
      if (!(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer) return unknown;
      return this.value(declaration.initializer, nested);
    }
    if (ts.isPropertyAssignment(declaration)) {
      if (ts.isComputedPropertyName(declaration.name)) return unknown;
      let owner: ts.Node = declaration;
      while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
      if (!owner || !ts.isVariableDeclaration(owner) || !(owner.parent.flags & ts.NodeFlags.Const)) return unknown;
      return this.value(declaration.initializer, nested);
    }
    return unknown;
  }

  private value(node: ts.Expression, seen: Set<ts.Symbol>): StaticValue {
    while (
      ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
    ) node = node.expression;
    if (ts.isStringLiteralLike(node)) return text(node.text);
    if (ts.isTemplateExpression(node)) {
      let value: StaticValue = text(node.head.text);
      for (const span of node.templateSpans)
        value = combine(combine(value, this.value(span.expression, seen)), text(span.literal.text));
      return value;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return combine(this.value(node.left, seen), this.value(node.right, seen));
    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.value(node.whenTrue, seen);
      const whenFalse = this.value(node.whenFalse, seen);
      if (whenTrue.kind === "package" && whenFalse.kind === "package" && whenTrue.specifier === whenFalse.specifier)
        return whenTrue;
      if (whenTrue.kind === "text" && whenFalse.kind === "text" && whenTrue.prefix === whenFalse.prefix && whenTrue.complete === whenFalse.complete)
        return whenTrue;
      return unknown;
    }
    if (ts.isIdentifier(node)) {
      const symbol = this.symbolAt(node);
      return symbol ? this.symbolValue(symbol, seen) : unknown;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "href") return this.value(node.expression, seen);
      const symbol = this.symbolAt(node.name);
      return symbol ? this.symbolValue(symbol, seen) : unknown;
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
      const symbol = this.symbolAt(node.argumentExpression);
      return symbol ? this.symbolValue(symbol, seen) : unknown;
    }
    if (ts.isCallExpression(node) && node.expression.getText(node.getSourceFile()) === "import.meta.resolve") {
      const specifier = node.arguments[0];
      return specifier && ts.isStringLiteralLike(specifier) ? { kind: "package", specifier: specifier.text } : unknown;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" &&
      this.isUnshadowedGlobal(node.expression) && node.arguments?.length) {
      const value = this.value(node.arguments[0]!, seen);
      const base = node.arguments[1] ? this.value(node.arguments[1], seen) : undefined;
      if (base?.kind === "package")
        return safePackagePath(value) ? base : value.kind === "text" && /^[a-z][a-z\d+.-]*:\/\//i.test(value.prefix) ? value : unknown;
      if (value.kind === "package") return value;
      if (value.kind !== "text") return unknown;
      if (base?.kind === "text" && base.complete) {
        try {
          return text(new URL(value.prefix, base.prefix).href, value.complete);
        } catch { return unknown; }
      }
      return value;
    }
    return unknown;
  }

  private collectMutations(): void {
    const mark = (node: ts.Node): void => {
      let symbol = this.symbolAt(node);
      const seen = new Set<ts.Symbol>();
      while (symbol && !seen.has(symbol)) {
        seen.add(symbol);
        this.mutated.add(symbol);
        symbol = this.aliases.get(symbol);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) {
        if (ts.isIdentifier(node.left)) mark(node.left);
        if (ts.isPropertyAccessExpression(node.left) && authorityMutation(node.left.name.text)) {
          mark(node.left.name);
          mark(node.left.expression);
        }
        if (ts.isElementAccessExpression(node.left) && node.left.argumentExpression &&
          ts.isStringLiteralLike(node.left.argumentExpression) && authorityMutation(node.left.argumentExpression.text))
          mark(node.left.expression);
      }
      if (ts.isDeleteExpression(node) && ts.isPropertyAccessExpression(node.expression) && authorityMutation(node.expression.name.text)) {
        mark(node.expression.name);
        mark(node.expression.expression);
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isPropertyAccessExpression(node.operand) && authorityMutation(node.operand.name.text)) {
        mark(node.operand.name);
        mark(node.operand.expression);
      }
      ts.forEachChild(node, visit);
    };
    for (const source of this.program.getSourceFiles()) if (this.files.has(resolve(source.fileName))) visit(source);
  }

  private collectAliases(): void {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && ts.isIdentifier(node.initializer) &&
        node.parent.flags & ts.NodeFlags.Const) {
        const alias = this.symbolAt(node.name);
        const target = this.symbolAt(node.initializer);
        if (alias && target && alias !== target) this.aliases.set(alias, target);
      }
      ts.forEachChild(node, visit);
    };
    for (const source of this.program.getSourceFiles()) if (this.files.has(resolve(source.fileName))) visit(source);
  }
}
