import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  loadSqlSchemaExpectations,
  parseProductMigrationMarkers,
  parseRegistrySchemaVersions,
} from "./sql-schema-expectations.ts";
import { storageSchemas } from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";
import { currentStorageSchema } from "../../.upstream/packages/sdk/src/implementation/storage-current.ts";
import { registrySchema } from "../../.upstream/packages/app-registry/src/implementation/storage-runtime.ts";
import { historySchemaMigrations } from "../../src/pool/model-history/schema.ts";

const root = resolve(import.meta.dirname, "../..");
const product = (entries: string, journal = "private_hosted_migrations") =>
  `migrateProductSteps(${JSON.stringify(journal)}, { ${entries} });`;
const registry = (schemas = "legacy, layout", legacyVersion = "fixture-old") => `
  import { registrySchema as layout } from "./storage-runtime.ts";
  const ignored = schema({ version: "unregistered" });
  const legacy = schema({ version: "${legacyVersion}", tables: {} });
  const factory = fumadb({ namespace: "executor_public_apps", schemas: [${schemas}] });
`;

test("product extraction follows the exact journal call and preserves every ID/name pair", () => {
  const source = `
    const decoy = { "900_not_a_migration": 1 };
    ${product('"2_second": anything, "10_later": anything')}
    ${product('"1_other_namespace": anything', "private_cloud_migrations")}
  `;
  assert.deepEqual(parseProductMigrationMarkers(source, "private_hosted_migrations"), [
    "2_second",
    "10_later",
  ]);
  assert.deepEqual(parseProductMigrationMarkers(source, "private_cloud_migrations"), [
    "1_other_namespace",
  ]);
  assert.deepEqual(
    parseProductMigrationMarkers(
      product('"2_renamed": anything, "10_later": anything, "12_added": anything'),
      "private_hosted_migrations",
    ),
    ["2_renamed", "10_later", "12_added"],
  );
});

for (const [name, source] of [
  ["missing call", "const unrelated = {};"],
  ["duplicate call", `${product('"1_one": run')}${product('"2_two": run')}`],
  ["spread", product('"1_one": run, ...extra')],
  ["computed key", product('["1_one"]: run')],
  ["shorthand", product("one")],
  ["method", product('"1_one"() {}')],
  ["duplicate key", product('"1_one": run, "1_one": run')],
  ["duplicate numeric ID", product('"01_one": run, "1_other": run')],
  ["invalid key", product('"next": run')],
  ["zero ID", product('"0_zero": run')],
  ["overflow ID", product('"2147483648_overflow": run')],
  ["empty registry", product("")],
  ["indirect registry", 'migrateProductSteps("private_hosted_migrations", steps)'],
  ["dynamic journal", 'migrateProductSteps(journal, { "1_one": run })'],
  [
    "additional argument",
    'migrateProductSteps("private_hosted_migrations", { "1_one": run }, extra)',
  ],
  ["invalid syntax", 'migrateProductSteps("private_hosted_migrations", { "1_one": })'],
] as const) {
  test(`product extraction refuses ${name}`, () => {
    assert.throws(
      () => parseProductMigrationMarkers(source, "private_hosted_migrations"),
      /sql-schema-expectations-invalid/,
    );
  });
}

test("registry extraction derives private versions in factory order and the imported runtime target", () => {
  assert.deepEqual(parseRegistrySchemaVersions(registry(), "fixture-current"), [
    "fixture-old",
    "fixture-current",
  ]);
  assert.deepEqual(
    parseRegistrySchemaVersions(registry("legacy, layout", "changed-old"), "changed-current"),
    ["changed-old", "changed-current"],
  );
  const additional = `${registry("legacy, middle, layout")}
    const middle = schema({ version: "fixture-middle", tables: {} });`;
  assert.deepEqual(parseRegistrySchemaVersions(additional, "fixture-current"), [
    "fixture-old",
    "fixture-middle",
    "fixture-current",
  ]);
});

for (const [name, source] of [
  ["spread schemas", registry("...extra, layout")],
  ["computed schemas", registry("schemas[0], layout")],
  ["duplicate versions", registry("legacy, legacy, layout")],
  ["missing runtime target", registry("legacy")],
  ["non-final runtime target", registry("layout, legacy")],
  ["unregistered reference", registry("unknown, layout")],
  ["dynamic legacy version", registry().replace('version: "fixture-old"', "version: dynamic")],
  [
    "wrong namespace",
    registry().replace('namespace: "executor_public_apps"', 'namespace: "other"'),
  ],
  ["wrong import", registry().replace("./storage-runtime.ts", "./unrelated.ts")],
] as const) {
  test(`registry extraction refuses ${name}`, () => {
    assert.throws(
      () => parseRegistrySchemaVersions(source, "fixture-current"),
      /sql-schema-expectations-invalid/,
    );
  });
}

test("all six expectations derive from the actual candidate registries and supplied Home target", async () => {
  const expectations = await loadSqlSchemaExpectations(73);
  assert.deepEqual(
    expectations.map((entry) => entry.namespace),
    ["hosted", "cloud", "sdk", "registry", "model-history", "home"],
  );
  const sdk = expectations.find((entry) => entry.namespace === "sdk")!;
  assert.deepEqual(
    sdk.registered,
    storageSchemas.map((entry) => entry.version),
  );
  assert.deepEqual(sdk.expected, [storageSchemas.at(-1)!.version]);
  assert.ok(sdk.registered!.includes(currentStorageSchema.version));
  const publicRegistry = expectations.find((entry) => entry.namespace === "registry")!;
  assert.deepEqual(publicRegistry.expected, [registrySchema.version]);
  const registrySource = await readFile(
    resolve(root, ".upstream/packages/app-registry/src/implementation/storage.ts"),
    "utf8",
  );
  assert.deepEqual(
    publicRegistry.registered,
    parseRegistrySchemaVersions(registrySource, registrySchema.version),
  );
  assert.equal(publicRegistry.registered!.length, 2);
  assert.deepEqual(
    expectations.find((entry) => entry.namespace === "model-history")!.expected,
    historySchemaMigrations.map((entry) => entry.name),
  );
  assert.deepEqual(expectations.find((entry) => entry.namespace === "home")!.expected, ["73"]);
  for (const [namespace, sourcePath, journal] of [
    [
      "hosted",
      ".upstream/apps/hosted/server/src/implementation/migrations.ts",
      "private_hosted_migrations",
    ],
    [
      "cloud",
      ".upstream/apps/hosted/cloud/src/implementation/migrations.ts",
      "private_cloud_migrations",
    ],
  ] as const) {
    const source = await readFile(resolve(root, sourcePath), "utf8");
    assert.deepEqual(
      expectations.find((entry) => entry.namespace === namespace)!.expected,
      parseProductMigrationMarkers(source, journal),
    );
  }
});

test("Home target must come from a valid candidate version", async () => {
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(loadSqlSchemaExpectations(version), /invalid candidate Home version/);
});
