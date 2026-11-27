import ts from "../architecture/typescript.ts";
import { BarrierRefusal } from "../pool-fleet/refusal.ts";

function refuse(): never {
  throw new BarrierRefusal(
    "sql-schema-expectations-invalid",
    "unsupported Cloud migration registry wrapper or runner",
  );
}

function imported(file: ts.SourceFile, module: string, name: string) {
  const aliases: string[] = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const entry of bindings.elements)
        if ((entry.propertyName?.text ?? entry.name.text) === name) aliases.push(entry.name.text);
  }
  if (aliases.length > 1) refuse();
  return aliases[0];
}

function declaration(file: ts.SourceFile, name: string, exported = false) {
  const matches: ts.Expression[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const entry of statement.declarationList.declarations) {
      if (!ts.isIdentifier(entry.name) || entry.name.text !== name) continue;
      if (
        !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        !entry.initializer ||
        (exported && !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      )
        refuse();
      matches.push(entry.initializer);
    }
  }
  if (matches.length !== 1) refuse();
  return matches[0]!;
}

function calls(node: ts.Node, name: string) {
  const found: ts.CallExpression[] = [];
  const visit = (child: ts.Node) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === name
    )
      found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function method(node: ts.Node, receiver: string, name: string, count: number) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== receiver ||
    node.expression.name.text !== name ||
    node.arguments.length !== count
  )
    refuse();
  return node;
}

function requireTransactionalPath(call: ts.CallExpression, implementation: ts.ArrowFunction) {
  const andThen = method(call.parent, "Effect", "andThen", 1);
  if (andThen.arguments[0] !== call) refuse();
  const pipeline = method(andThen.parent, "verify", "pipe", 2);
  if (pipeline.arguments[0] !== andThen) refuse();
  const after = method(pipeline.arguments[1]!, "Effect", "andThen", 1);
  if (!ts.isIdentifier(after.arguments[0]!) || after.arguments[0]!.text !== "verify") refuse();
  const transaction = method(pipeline.parent, "sql", "withTransaction", 1);
  if (transaction.arguments[0] !== pipeline) refuse();
  const yielded = transaction.parent;
  if (
    !ts.isYieldExpression(yielded) ||
    !yielded.asteriskToken ||
    yielded.expression !== transaction ||
    !ts.isExpressionStatement(yielded.parent) ||
    !ts.isBlock(yielded.parent.parent)
  )
    refuse();
  const body = yielded.parent.parent;
  const generator = body.parent;
  if (
    !ts.isFunctionExpression(generator) ||
    !generator.asteriskToken ||
    generator.parameters.length ||
    body.statements.length !== 3 ||
    body.statements.at(-1) !== yielded.parent
  )
    refuse();
  const [sql, verify] = body.statements.slice(0, 2).map((statement, index) => {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1
    )
      refuse();
    const entry = statement.declarationList.declarations[0]!;
    if (
      !ts.isIdentifier(entry.name) ||
      entry.name.text !== ["sql", "verify"][index] ||
      !entry.initializer
    )
      refuse();
    return entry.initializer;
  });
  if (
    !sql ||
    !ts.isYieldExpression(sql) ||
    !sql.asteriskToken ||
    !sql.expression ||
    !ts.isPropertyAccessExpression(sql.expression) ||
    !ts.isIdentifier(sql.expression.expression) ||
    sql.expression.expression.text !== "SqlClient" ||
    sql.expression.name.text !== "SqlClient" ||
    !verify
  )
    refuse();
  method(verify, "Effect", "gen", 1);
  const generation = method(generator.parent, "Effect", "gen", 1);
  if (
    generation.arguments[0] !== generator ||
    !ts.isPropertyAccessExpression(generation.parent) ||
    generation.parent.expression !== generation ||
    generation.parent.name.text !== "pipe" ||
    !ts.isCallExpression(generation.parent.parent) ||
    generation.parent.parent !== implementation.body
  )
    refuse();
  const mapped = generation.parent.parent;
  if (mapped.arguments.length !== 1) refuse();
  const mapError = method(mapped.arguments[0]!, "Effect", "mapError", 1);
  const failure = mapError.arguments[0]!;
  if (
    !ts.isCallExpression(failure) ||
    !ts.isIdentifier(failure.expression) ||
    failure.expression.text !== "migrationFailed" ||
    failure.arguments.length !== 1 ||
    !ts.isStringLiteral(failure.arguments[0]!) ||
    failure.arguments[0]!.text !== "product"
  )
    refuse();
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === "steps" &&
      node !== implementation.parameters[0]!.name
    ) {
      const parent = node.parent;
      if (parent !== call) {
        const keys = method(parent, "Object", "keys", 1);
        if (keys.arguments[0] !== node) refuse();
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(implementation.body);
}

/** Follow only the declared default registry through the known transactional runner. */
export function cloudMigrationRegistry(file: ts.SourceFile, runner: ts.SourceFile | undefined) {
  const alias = imported(file, "./cloud-migration-runner.ts", "migrateCloudProductSteps");
  if (!alias) return undefined;
  if (!runner) refuse();
  const wrapper = declaration(file, "migrateCloudProductSteps", true);
  if (!ts.isArrowFunction(wrapper) || wrapper.parameters.length !== 1) refuse();
  const parameter = wrapper.parameters[0]!;
  if (
    !ts.isIdentifier(parameter.name) ||
    parameter.name.text !== "steps" ||
    !parameter.initializer ||
    !ts.isIdentifier(parameter.initializer) ||
    parameter.dotDotDotToken ||
    parameter.questionToken
  )
    refuse();
  const call = wrapper.body;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== alias ||
    call.arguments.length !== 1 ||
    !ts.isIdentifier(call.arguments[0]!) ||
    call.arguments[0]!.text !== parameter.name.text ||
    calls(file, alias).length !== 1
  )
    refuse();
  const invocations = calls(file, "migrateCloudProductSteps");
  if (invocations.length !== 1 || invocations[0]!.arguments.length !== 0) refuse();
  const registry = declaration(file, parameter.initializer.text);
  if (!ts.isObjectLiteralExpression(registry)) refuse();
  const inspectRegistry = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === parameter.initializer!.getText(file) &&
      node !== parameter.initializer &&
      !(
        ts.isVariableDeclaration(node.parent) &&
        node.parent.name === node &&
        node.parent.initializer === registry
      )
    )
      refuse();
    ts.forEachChild(node, inspectRegistry);
  };
  inspectRegistry(file);

  const migration = imported(
    runner,
    "@executor-js/hosted-server/migrations",
    "migrateProductSteps",
  );
  if (
    !migration ||
    imported(runner, "effect", "Effect") !== "Effect" ||
    imported(runner, "effect/sql", "SqlClient") !== "SqlClient" ||
    imported(runner, "@executor-js/hosted-server/migrations", "migrationFailed") !==
      "migrationFailed"
  )
    refuse();
  const implementation = declaration(runner, "migrateCloudProductSteps", true);
  if (!ts.isArrowFunction(implementation) || implementation.parameters.length !== 1) refuse();
  const input = implementation.parameters[0]!;
  if (
    !ts.isIdentifier(input.name) ||
    input.name.text !== "steps" ||
    input.initializer ||
    input.dotDotDotToken ||
    input.questionToken
  )
    refuse();
  const delegated = calls(implementation.body, migration);
  const journalCall = delegated[0];
  if (
    delegated.length !== 1 ||
    calls(runner, migration).length !== 1 ||
    !journalCall ||
    journalCall.arguments.length !== 2 ||
    !ts.isStringLiteral(journalCall.arguments[0]!) ||
    journalCall.arguments[0]!.text !== "private_cloud_migrations" ||
    !ts.isIdentifier(journalCall.arguments[1]!) ||
    journalCall.arguments[1]!.text !== input.name.text
  )
    refuse();
  requireTransactionalPath(journalCall, implementation);
  return registry;
}
