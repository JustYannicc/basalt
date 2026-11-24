export const TEST_PATH =
  /(?:^|\/)(?:test|tests|fixtures|[\w-]+-tests)\/|\.test\.[cm]?[jt]sx?$|(?:^|[/.-])fixtures?(?:-[\w-]+)?\.[cm]?[jt]s$|[.-](?:stand-?ins?|test-utils)\.[cm]?[jt]s$/u;
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

export const absolutePath = (context) =>
  (context.physicalFilename ?? context.filename).replaceAll("\\", "/");
// Relative to the repository, so a checkout directory named like a test path changes nothing.
export const filePath = (context) => {
  const absolute = absolutePath(context);
  const cwd = (context.cwd ?? "").replaceAll("\\", "/").replace(/\/$/u, "");
  return cwd && absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
};
export const isTest = (context) => TEST_PATH.test(filePath(context));
export const keyName = (property) => {
  if (property?.type !== "Property") return undefined;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" ? String(property.key.value) : undefined;
};
export const memberRootNode = (node) => {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  return current;
};
export const memberRoot = (node) => {
  const root = memberRootNode(node);
  return root?.type === "Identifier" ? root.name : undefined;
};
export const propertyName = (node) =>
  node?.type === "MemberExpression" && !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node?.type === "Identifier"
      ? node.name
      : undefined;
// Casts, `await` and `!` do not change which value is passed.
export const unwrap = (node) => {
  let current = node;
  while (
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "AwaitExpression",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(current?.type)
  )
    current = current.expression ?? current.argument;
  return current;
};
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
// Local name -> imported name, so `import { isDeepStrictEqual as same }` is still recognised.
export const importAliases = (context) => {
  const aliases = new Map();
  for (const statement of context.sourceCode.ast.body)
    if (statement.type === "ImportDeclaration")
      for (const specifier of statement.specifiers)
        if (specifier.type === "ImportSpecifier")
          aliases.set(specifier.local.name, specifier.imported.name ?? specifier.imported.value);
  return aliases;
};
export const definition = (context, identifier) => {
  for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable.defs.at(-1);
  }
  return undefined;
};
export const variableInit = (context, identifier) => {
  const found = definition(context, identifier);
  return found?.node?.type === "VariableDeclarator" ? found.node : undefined;
};
// An identifier's value when it is a local constant, so `const options = {...}` is read through.
export const resolved = (context, node) => {
  const value = unwrap(node);
  if (value?.type !== "Identifier") return value;
  return unwrap(variableInit(context, value)?.init) ?? value;
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
// A parameter declared with the SDK's request type is a request someone else built and checked.
export const typedParameter = (context, identifier, names) => {
  const found = definition(context, identifier);
  return found?.type === "Parameter" && requestTypeAnnotation(found.name.typeAnnotation, names);
};
// A call into an SDK: `Workers.getScript(...)`, `getScript(...)` imported by name.
export const sdkCall = (node, names) =>
  node.type === "CallExpression" &&
  ((node.callee.type === "Identifier" && names.has(node.callee.name)) ||
    (node.callee.type === "MemberExpression" && names.has(memberRoot(node.callee))));
// `const W = Workers` and `const { getScript } = Workers` keep reaching the SDK.
export const addAliases = (declarator, names) => {
  const init = unwrap(declarator.init);
  if (
    !init ||
    !(init.type === "Identifier"
      ? names.has(init.name)
      : init.type === "MemberExpression" && names.has(memberRoot(init)))
  )
    return;
  if (declarator.id.type === "Identifier") names.add(declarator.id.name);
  if (declarator.id.type === "ObjectPattern")
    for (const property of declarator.id.properties)
      if (property.type === "Property" && property.value.type === "Identifier")
        names.add(property.value.name);
};
