import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../architecture/typescript.ts";
import { BarrierRefusal } from "./refusal.ts";
import { validateSqlExpectations, type SqlSchemaExpectation } from "./sql-schema-contract.ts";

function refuse(detail: string): never {
  throw new BarrierRefusal("sql-schema-expectations-invalid", detail);
}

function parse(source: string) {
  const diagnostics = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics;
  if (diagnostics?.some((entry) => entry.category === ts.DiagnosticCategory.Error))
    refuse("invalid migration source syntax");
  return ts.createSourceFile("schema.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function properties(node: ts.Node | undefined) {
  if (!node || !ts.isObjectLiteralExpression(node)) refuse("expected literal schema object");
  const entries = new Map<string, ts.Expression>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name))
      refuse("unsupported schema object property");
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name))
      refuse("unsupported schema object key");
    if (entries.has(name.text)) refuse(`duplicate schema object key ${name.text}`);
    entries.set(name.text, property.initializer);
  }
  return entries;
}

/** Product journals split each source key into its numeric ID and suffix. */
export function parseProductMigrationMarkers(source: string, journal: string): string[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "migrateProductSteps"
    ) {
      const name = node.arguments[0];
      if (!name || !ts.isStringLiteral(name)) refuse("unsupported product migration journal");
      if (name.text === journal) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  if (calls.length !== 1 || calls[0]!.arguments.length !== 2)
    refuse(`expected one migrateProductSteps call for ${journal}`);
  const ids = new Set<number>();
  const markers = [...properties(calls[0]!.arguments[1]).keys()].map((key) => {
    const match = /^(\d+)_([a-zA-Z0-9_.-]+)$/.exec(key);
    if (!match) refuse(`invalid product migration key ${key}`);
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647 || ids.has(id))
      refuse(`invalid or duplicate product migration ID ${match[1]}`);
    ids.add(id);
    const marker = `${id}_${match[2]}`;
    if (marker.length > 160) refuse("product migration key too long");
    return { id, marker };
  });
  if (!markers.length) refuse(`empty product migration registry ${journal}`);
  return markers.sort((left, right) => left.id - right.id).map((entry) => entry.marker);
}

function version(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/.test(value))
    refuse("invalid registered schema version");
  return value;
}

function versions(values: unknown): string[] {
  if (!Array.isArray(values) || !values.length) refuse("empty or missing schema registry");
  const registered = values.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("version" in entry))
      refuse("schema registry entry has no version");
    return version(entry.version);
  });
  if (new Set(registered).size !== registered.length) refuse("duplicate registered schema version");
  return registered;
}

/** Resolve only the factory's registered schemas, including its private legacy layout. */
export function parseRegistrySchemaVersions(source: string, currentVersion: string): string[] {
  const file = parse(source);
  const declarations = new Map<string, ts.Expression>();
  const currentAliases = new Set<string>();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./storage-runtime.ts"
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements)
          if ((entry.propertyName?.text ?? entry.name.text) === "registrySchema")
            currentAliases.add(entry.name.text);
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (declarations.has(declaration.name.text)) refuse("duplicate registry declaration");
      declarations.set(declaration.name.text, declaration.initializer);
    }
  }
  const factory = declarations.get("factory");
  if (
    !factory ||
    !ts.isCallExpression(factory) ||
    !ts.isIdentifier(factory.expression) ||
    factory.expression.text !== "fumadb" ||
    factory.arguments.length !== 1
  )
    refuse("unsupported registry factory");
  const factoryProperties = properties(factory.arguments[0]);
  const namespace = factoryProperties.get("namespace");
  if (!namespace || !ts.isStringLiteral(namespace) || namespace.text !== "executor_public_apps")
    refuse("unexpected registry namespace");
  const schemas = factoryProperties.get("schemas");
  if (!schemas || !ts.isArrayLiteralExpression(schemas)) refuse("unsupported registry schemas");
  let currentCount = 0;
  const registered = schemas.elements.map((entry) => {
    if (!ts.isIdentifier(entry)) refuse("unsupported registered registry schema");
    if (currentAliases.has(entry.text)) {
      currentCount++;
      return { version: currentVersion };
    }
    const declaration = declarations.get(entry.text);
    if (
      !declaration ||
      !ts.isCallExpression(declaration) ||
      !ts.isIdentifier(declaration.expression) ||
      declaration.expression.text !== "schema" ||
      declaration.arguments.length !== 1
    )
      refuse("unsupported legacy registry schema");
    const value = properties(declaration.arguments[0]).get("version");
    if (!value || !ts.isStringLiteral(value)) refuse("unsupported legacy registry version");
    return { version: value.text };
  });
  const result = versions(registered);
  if (currentCount !== 1 || result.at(-1) !== currentVersion)
    refuse("registry factory must end at its current schema");
  return result;
}

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function loadSqlSchemaExpectations(
  homeVersion: number,
): Promise<SqlSchemaExpectation[]> {
  if (!Number.isSafeInteger(homeVersion) || homeVersion < 1)
    refuse("invalid candidate Home version");
  const [hosted, cloud, registrySource, sdk, registry, history] = await Promise.all([
    readFile(
      resolve(root, ".upstream/apps/hosted/server/src/implementation/migrations.ts"),
      "utf8",
    ),
    readFile(resolve(root, ".upstream/apps/hosted/cloud/src/implementation/migrations.ts"), "utf8"),
    readFile(
      resolve(root, ".upstream/packages/app-registry/src/implementation/storage.ts"),
      "utf8",
    ),
    import("../../.upstream/packages/sdk/src/implementation/storage-migrations.ts"),
    import("../../.upstream/packages/app-registry/src/implementation/storage-runtime.ts"),
    import("../../src/pool/model-history/schema.ts"),
  ]);
  const sdkVersions = versions(sdk.storageSchemas);
  const registryVersion = versions([registry.registrySchema])[0]!;
  const registryVersions = parseRegistrySchemaVersions(registrySource, registryVersion);
  if (!Array.isArray(history.historySchemaMigrations)) refuse("missing history migration registry");
  const historyVersions = history.historySchemaMigrations.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("name" in entry))
      refuse("invalid history migration entry");
    return version(entry.name);
  });
  const hostedVersions = parseProductMigrationMarkers(hosted, "private_hosted_migrations");
  const hostedActivation =
    hostedVersions.includes("21_change_journal_prepare") &&
    /values\s*\(22,\s*'change_journal_activate'\)/u.test(hosted)
      ? ["22_change_journal_activate"]
      : [];
  const declaredHistoryActivation: unknown =
    "historyJournalActivationMigration" in history
      ? history.historyJournalActivationMigration
      : undefined;
  const historyActivation =
    historyVersions.includes("model_request_history_v9_change_journal_prepare") &&
    declaredHistoryActivation !== null &&
    typeof declaredHistoryActivation === "object" &&
    "name" in declaredHistoryActivation &&
    declaredHistoryActivation.name === "model_request_history_v10_change_journal_activate"
      ? [declaredHistoryActivation.name]
      : [];
  const expectations: SqlSchemaExpectation[] = [
    {
      namespace: "hosted",
      database: "tools",
      journal: "private_hosted_migrations",
      kind: "markers",
      expected: hostedVersions,
      ...(hostedActivation.length ? { optional: hostedActivation } : {}),
    },
    {
      namespace: "cloud",
      database: "tools",
      journal: "private_cloud_migrations",
      kind: "markers",
      expected: parseProductMigrationMarkers(cloud, "private_cloud_migrations"),
    },
    {
      namespace: "sdk",
      database: "tools",
      journal: "private_executor_settings",
      kind: "version",
      expected: [sdkVersions.at(-1)!],
      registered: sdkVersions,
    },
    {
      namespace: "registry",
      database: "tools",
      journal: "private_executor_public_apps_settings",
      kind: "version",
      expected: [registryVersion],
      registered: registryVersions,
    },
    {
      namespace: "model-history",
      database: "pool",
      journal: "basalt_model_history_migrations",
      kind: "markers",
      expected: historyVersions,
      ...(historyActivation.length ? { optional: historyActivation } : {}),
    },
    {
      namespace: "home",
      database: "pool",
      journal: "home_schema_migration",
      kind: "home",
      expected: [String(homeVersion)],
    },
  ];
  validateSqlExpectations(expectations);
  return expectations;
}
