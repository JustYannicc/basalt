// Shared AST and path helpers for Basalt's Oxlint rules.

export const TEST_PATH =
  /(?:^|\/)(?:test|tests|fixtures|[\w-]+-tests)\/|\.test\.[cm]?[jt]s$|(?:^|[/.-])fixtures?(?:-[\w-]+)?\.[cm]?[jt]s$|[.-](?:stand-?ins?|test-utils)\.[cm]?[jt]s$/u;
export const RECORDED_SHAPES =
  /(?:^|\/)(?:[^/]*-shapes?|recorded-[^/]*|prod-shapes\/[^/]*)\.[cm]?[jt]s$|(?:^|\/)(?:prod-shapes|recorded)\//u;
export const PROVIDER_SDK = /^@distilled\.cloud\//u;
export const SPAWNERS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
]);
export const filePath = (context) =>
  (context.physicalFilename ?? context.filename).replaceAll("\\", "/");
export const isTest = (context) => TEST_PATH.test(filePath(context));
export const keyName = (property) => {
  if (property?.type !== "Property") return undefined;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" ? String(property.key.value) : undefined;
};
export const memberRoot = (node) => {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  return current?.type === "Identifier" ? current.name : undefined;
};
export const propertyName = (node) =>
  node?.type === "MemberExpression" && !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node?.type === "Identifier"
      ? node.name
      : undefined;
export const importedNames = (context, source, { values = true } = {}) => {
  const names = new Set();
  for (const statement of context.sourceCode.ast.body) {
    if (statement.type !== "ImportDeclaration" || !source.test(statement.source.value)) continue;
    if (values && statement.importKind === "type") continue;
    for (const specifier of statement.specifiers)
      if (!values || specifier.importKind !== "type") names.add(specifier.local.name);
  }
  return names;
};
// A call into an SDK: `Workers.getScript(...)`, `getScript(...)` imported by name.
export const sdkCall = (node, names) =>
  node.type === "CallExpression" &&
  ((node.callee.type === "Identifier" && names.has(node.callee.name)) ||
    (node.callee.type === "MemberExpression" && names.has(memberRoot(node.callee))));
export const variableInit = (context, identifier) => {
  for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (!variable) continue;
    const definition = variable.defs.at(-1);
    return definition?.node?.type === "VariableDeclarator" ? definition.node : undefined;
  }
  return undefined;
};
// A parameter declared with the SDK's request type is a request someone else built and checked.
export const typedParameter = (context, identifier, names) => {
  for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (!variable) continue;
    const definition = variable.defs.at(-1);
    return (
      definition?.type === "Parameter" &&
      requestTypeAnnotation(definition.name.typeAnnotation, names)
    );
  }
  return false;
};
export const requestTypeAnnotation = (annotation, names) => {
  const type = annotation?.typeAnnotation;
  if (type?.type !== "TSTypeReference") return false;
  const name = type.typeName;
  return (
    name.type === "TSQualifiedName" &&
    name.left.type === "Identifier" &&
    names.has(name.left.name) &&
    name.right.name.endsWith("Request")
  );
};

export const memberRootNode = (node) => {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  return current;
};
