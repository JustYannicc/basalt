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

  function constInitializer(variable) {
    if (!variable || variable.defs?.length !== 1) return null;
    const definition = variable.defs[0];
    const declarator = definition.node;
    if (definition.type !== "Variable" || definition.parent?.kind !== "const") return null;
    if (declarator?.type !== "VariableDeclarator" || declarator.id?.type !== "Identifier")
      return null;
    if (declarator.id.name !== variable.name || !declarator.init) return null;
    return declarator.init;
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
      if (declaration?.source?.value !== "apps") continue;
      if (definition.node?.type === "ImportNamespaceSpecifier") return "namespace";
      if (definition.node?.type === "ImportSpecifier") {
        const imported = definition.node.imported?.name ?? definition.node.imported?.value;
        if (
          ["defineApp", "mutation", "query", "QueryContext", "MutationContext"].includes(imported)
        )
          return imported;
      }
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
      const imported = importKind(variable);
      if (imported) return imported;
      seen.add(variable);
      if (symbolCache.has(variable)) return symbolCache.get(variable);
      const symbol = resolveSymbol(constInitializer(variable), seen);
      seen.delete(variable);
      symbolCache.set(variable, symbol);
      return symbol;
    }
    if (node.type === "MemberExpression") {
      const objectSymbol = resolveSymbol(node.object, seen);
      if (objectSymbol !== "namespace") return null;
      const name = propertyName(node.property, node.computed);
      return ["defineApp", "mutation", "query"].includes(name) ? name : null;
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
    const initializer = unwrapExpression(constInitializer(variable));
    if (initializer) return resolveFunctionNode(initializer, seen);
    for (const definition of variable.defs ?? []) {
      if (definition.type === "FunctionName" && definition.node?.type === "FunctionDeclaration") {
        return definition.node;
      }
    }
    return null;
  }

  return { variableOf, constInitializer, typeAlias, resolveSymbol, resolveFunctionNode };
}
