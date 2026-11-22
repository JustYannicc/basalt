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
import { observeSqlVersions } from "../release/sql-schema-contract.ts";

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

test("operator migration keys are recognized without becoming required journal markers", () => {
  for (const operators of ['["22_change_journal_activate"]', "[]"]) {
    const source = `migrateProductSteps("private_hosted_migrations", {
      "21_change_journal_prepare": prepare,
      "20_account_changes": changes,
    }, ${operators});`;
    assert.deepEqual(parseProductMigrationMarkers(source, "private_hosted_migrations"), [
      "20_account_changes",
      "21_change_journal_prepare",
    ]);
  }
});

for (const [name, operators] of [
  ["indirect list", "operatorKeys"],
  ["object", '{ "22_change_journal_activate": activate }'],
  ["spread", "[...operatorKeys]"],
  ["nonliteral key", "[operatorKey]"],
  ["number", "[22]"],
  ["missing suffix", '["22"]'],
  ["noncanonical ID", '["022_change_journal_activate"]'],
  ["zero ID", '["0_change_journal_activate"]'],
  ["overflow ID", '["2147483648_change_journal_activate"]'],
  ["oversized key", JSON.stringify([`22_${"a".repeat(158)}`])],
  ["duplicate key", '["22_change_journal_activate", "22_change_journal_activate"]'],
  ["duplicate ID", '["22_change_journal_activate", "22_other"]'],
  ["scheduled ID", '["21_other"]'],
  ["scheduled key", '["21_change_journal_prepare"]'],
  ["fourth argument", '["22_change_journal_activate"], []'],
] as const)
  test(`operator migration list refuses ${name}`, () => {
    const source = `migrateProductSteps("private_hosted_migrations", {
      "21_change_journal_prepare": prepare,
    }, ${operators});`;
    assert.throws(
      () => parseProductMigrationMarkers(source, "private_hosted_migrations"),
      /sql-schema-expectations-invalid/,
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
  const hosted = expectations.find((entry) => entry.namespace === "hosted")!;
  assert.ok(hosted.expected.includes("21_change_journal_prepare"));
  assert.ok(!hosted.expected.includes("22_change_journal_activate"));
  assert.deepEqual(hosted.optional, ["22_change_journal_activate"]);
  for (const applied of [
    [...hosted.expected],
    [...hosted.expected, "22_change_journal_activate"],
  ]) {
    const observation = observeSqlVersions(hosted, applied);
    assert.equal(observation.status, "ready");
    assert.deepEqual(observation.pending, []);
    assert.deepEqual(observation.unexpected, []);
  }
  assert.equal(
    observeSqlVersions(
      hosted,
      [...hosted.expected, "22_change_journal_activate"].filter(
        (key) => key !== "21_change_journal_prepare",
      ),
    ).status,
    "pending",
  );
  assert.equal(
    observeSqlVersions(hosted, [...hosted.expected, "22_wrong_activation"]).status,
    "incompatible",
  );
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
      parseProductMigrationMarkers(
        source,
        journal,
        namespace === "cloud"
          ? await readFile(
              resolve(
                root,
                ".upstream/apps/hosted/cloud/src/implementation/cloud-migration-runner.ts",
              ),
              "utf8",
            )
          : undefined,
      ),
    );
  }
});

test("Home target must come from a valid candidate version", async () => {
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(loadSqlSchemaExpectations(version), /invalid candidate Home version/);
});
