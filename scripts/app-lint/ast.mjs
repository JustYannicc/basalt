import { createModuleGraph } from "./module-graph.mjs";

const expressionWrappers = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

export function unwrapExpression(node) {
  while (node && expressionWrappers.has(node.type)) node = node.expression;
  return node;
}

export function walkAst(root, visit) {
  const seen = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== "object" || typeof node.type !== "string" || seen.has(node))
      return;
    seen.add(node);
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
      } else {
        walk(value);
      }
    }
  }
  walk(root);
}

export function propertyName(key, computed = false) {
  if (!computed && key?.type === "Identifier") return key.name;
  if (["Literal", "StringLiteral"].includes(key?.type) && typeof key.value === "string")
    return key.value;
  if (key?.type === "TemplateLiteral" && key.expressions?.length === 0) {
    return key.quasis?.[0]?.value?.cooked ?? key.quasis?.[0]?.value?.raw;
  }
  return undefined;
}

export function createBindings(context) {
  const sourceCode = context.sourceCode;
  const moduleGraph = createModuleGraph(context, sourceCode.ast);
  const variableCache = new WeakMap();

  function variableOf(identifier) {
    if (!identifier || identifier.type !== "Identifier") return null;
    if (variableCache.has(identifier)) return variableCache.get(identifier);
    let variable = null;
    try {
      let scope = sourceCode.getScope(identifier);
      while (scope && !variable) {
        variable = scope.set?.get(identifier.name) ?? null;
        scope = scope.upper;
      }
    } catch {
      variable = null;
    }
    variableCache.set(identifier, variable);
    return variable;
  }

  function isUnmodified(variable) {
    if (!variable || !Array.isArray(variable.references)) return false;
    if (variable.references.some((reference) => typeof reference.isWrite !== "function"))
      return false;
    return variable.references.filter((reference) => reference.isWrite()).length <= 1;
  }

  function variableDeclarator(variable) {
    if (!variable || variable.defs?.length !== 1) return null;
    const definition = variable.defs[0];
    const declarator = definition.node;
    const kind = definition.parent?.kind;
    if (definition.type !== "Variable" || !["const", "let", "var"].includes(kind)) return null;
    if (declarator?.type !== "VariableDeclarator" || declarator.id?.type !== "Identifier")
      return null;
    if (declarator.id.name !== variable.name) return null;
    return { declarator, kind };
  }

  function possibleValues(variable) {
    const definition = variableDeclarator(variable);
    if (!definition) return [];
    const values = new Set();
    if (definition.declarator.init) values.add(definition.declarator.init);
    for (const reference of variable.references ?? []) {
      if (reference.isWrite() && reference.writeExpr) values.add(reference.writeExpr);
    }
    return [...values];
  }

  function localInitializer(variable) {
    const values = possibleValues(variable);
    return isUnmodified(variable) && values.length === 1 ? values[0] : null;
  }

  function constInitializer(variable) {
    const definition = variableDeclarator(variable);
    return definition?.kind === "const" && isUnmodified(variable)
      ? definition.declarator.init
      : null;
  }

  function typeAlias(variable) {
    for (const definition of variable?.defs ?? []) {
      if (definition.node?.type === "TSTypeAliasDeclaration") return definition.node.typeAnnotation;
    }
    return null;
  }

  function importKind(variable) {
    if (!variable) return null;
    for (const definition of variable.defs ?? []) {
      if (definition.type !== "ImportBinding") continue;
      let declaration = definition.parent ?? definition.node?.parent;
      while (declaration && declaration.type !== "ImportDeclaration")
        declaration = declaration.parent;
      if (!declaration?.source || typeof declaration.source.value !== "string") continue;
      if (definition.node?.type === "ImportNamespaceSpecifier") {
        return moduleGraph.resolveExport(declaration.source.value, "*");
      }
      if (definition.node?.type === "ImportSpecifier") {
        const imported = definition.node.imported?.name ?? definition.node.imported?.value;
        if (
          (declaration.importKind === "type" || definition.node?.importKind === "type") &&
          !["QueryContext", "MutationContext"].includes(imported)
        )
          continue;
        if (typeof imported === "string")
          return moduleGraph.resolveExport(declaration.source.value, imported);
      }
    }
    return null;
  }

  function literalString(node) {
    return ["Literal", "StringLiteral"].includes(node?.type) && typeof node.value === "string"
      ? node.value
      : null;
  }

  function dynamicImportSource(expression) {
    let node = unwrapExpression(expression);
    if (node?.type === "AwaitExpression") node = unwrapExpression(node.argument);
    if (node?.type === "ImportExpression") return literalString(node.source);
    if (node?.type === "CallExpression" && node.callee?.type === "Import")
      return literalString(node.arguments?.[0]);
    return null;
  }

  function dynamicImportKind(variable) {
    if (!variable || variable.defs?.length !== 1) return null;
    const definition = variable.defs[0];
    if (definition.type !== "Variable" || definition.node?.type !== "VariableDeclarator")
      return null;
    const { id, init } = definition.node;
    if (dynamicImportSource(init) !== "apps") return null;
    if (id?.type === "Identifier" && id.name === variable.name)
      return isUnmodified(variable) ? "namespace" : "unknown";
    if (id?.type !== "ObjectPattern") return null;
    for (const property of id.properties ?? []) {
      if (!["ObjectProperty", "Property"].includes(property.type)) continue;
      const value =
        property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
      if (value?.type !== "Identifier" || value.name !== variable.name) continue;
      const imported = propertyName(property.key, property.computed);
      if (!["defineApp", "mutation", "query", "QueryContext", "MutationContext"].includes(imported))
        return null;
      return isUnmodified(variable) ? imported : "unknown";
    }
    return null;
  }

  const symbolCache = new WeakMap();
  function resolveSymbol(expression, seen = new Set()) {
    const node = unwrapExpression(expression);
    if (!node) return null;
    if (node.type === "Identifier") {
      const variable = variableOf(node);
      if (!variable || seen.has(variable)) return null;
      if (symbolCache.has(variable)) return symbolCache.get(variable);
      const imported = importKind(variable);
      if (imported) return imported;
      const dynamic = dynamicImportKind(variable);
      if (dynamic) return dynamic;
      seen.add(variable);
      const symbols = possibleValues(variable)
        .map((value) => resolveSymbol(value, seen))
        .filter(Boolean);
      seen.delete(variable);
      const symbol = symbols[0] ?? null;
      const result =
        symbol && (!isUnmodified(variable) || symbols.some((value) => value !== symbol))
          ? "unknown"
          : symbol;
      symbolCache.set(variable, result);
      return result;
    }
    if (node.type === "MemberExpression") {
      const objectSymbol = resolveSymbol(node.object, seen);
      const name = propertyName(node.property, node.computed);
      if (!["defineApp", "mutation", "query"].includes(name)) return null;
      if (objectSymbol === "namespace") return name;
      if (objectSymbol === "unknown") return "unknown";
      if (objectSymbol?.kind === "namespace") return objectSymbol.members.get(name) ?? null;
      return null;
    }
    return null;
  }

  function resolveFunctionNode(expression, seen = new Set()) {
    const node = unwrapExpression(expression);
    if (["ArrowFunctionExpression", "FunctionExpression"].includes(node?.type)) return node;
    if (node?.type !== "Identifier") return null;
    const variable = variableOf(node);
    if (!variable || seen.has(variable)) return null;
    seen.add(variable);
    const initializer = unwrapExpression(localInitializer(variable));
    if (initializer) return resolveFunctionNode(initializer, seen);
    for (const definition of variable.defs ?? []) {
      if (definition.type === "FunctionName" && definition.node?.type === "FunctionDeclaration") {
        return definition.node;
      }
    }
    return null;
  }

  return {
    variableOf,
    isUnmodified,
    localInitializer,
    possibleValues,
    constInitializer,
    typeAlias,
    resolveSymbol,
    resolveFunctionNode,
  };
}
