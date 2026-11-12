import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSqlSchemas,
  observeSqlVersions,
  validateSqlExpectations,
  type SqlSchemaExpectation,
} from "./sql-schema-contract.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";

const candidate = "a".repeat(40);
const sdk: SqlSchemaExpectation = {
  namespace: "sdk",
  database: "tools",
  journal: "private_executor_settings",
  kind: "version",
  expected: ["4.0.29"],
  registered: ["4.0.27", "4.0.28", "4.0.29"],
};

test("ready means all six exact marker sets and candidate native obligations", () => {
  assert.doesNotThrow(() => assertSqlSchemas(readySqlSchemas(candidate), candidate));
  for (const namespace of [
    "hosted",
    "cloud",
    "sdk",
    "registry",
    "model-history",
    "home",
  ] as const) {
    const receipt = readySqlSchemas(candidate);
    receipt.observations.find((entry) => entry.namespace === namespace)!.applied = [];
    assert.throws(() => assertSqlSchemas(receipt, candidate), new RegExp(namespace));
  }
  const receipt = readySqlSchemas(candidate);
  receipt.home!.expectedIndexes = ["native_account_time"];
  receipt.home!.readyIndexes = [];
  receipt.home!.pendingIndexes = ["native_account_time"];
  receipt.home!.status = "pending";
  assert.throws(() => assertSqlSchemas(receipt, candidate), /home.*native_account_time/);
});

test("holes and unknown markers cannot pass a matching maximum", () => {
  const expected: SqlSchemaExpectation = {
    namespace: "hosted",
    database: "tools",
    journal: "private_hosted_migrations",
    kind: "markers",
    expected: ["1_base", "2_add", "3_latest"],
  };
  const hole = observeSqlVersions(expected, ["1_base", "3_latest"]);
  assert.deepEqual(hole.pending, ["2_add"]);
  assert.equal(hole.status, "pending");
  assert.equal(
    observeSqlVersions(expected, [...expected.expected, "4_future"]).status,
    "incompatible",
  );
});

test("registered order includes trailing SDK index versions and refuses unsupported versions", () => {
  assert.deepEqual(observeSqlVersions(sdk, ["4.0.27"]).pending, ["4.0.28", "4.0.29"]);
  assert.equal(observeSqlVersions(sdk, ["4.0.30"]).status, "incompatible");
  assert.equal(observeSqlVersions(sdk, ["4.0.26"]).status, "incompatible");
});

test("malformed expected scalar registries refuse instead of accepting a future final marker", () => {
  const valid = readySqlSchemas(candidate).observations.map((entry) => ({
    namespace: entry.namespace,
    database: entry.database,
    journal: entry.journal,
    kind: entry.namespace === "sdk" ? ("version" as const) : ("markers" as const),
    expected: entry.expected,
  }));
  const index = valid.findIndex((entry) => entry.namespace === "sdk");
  for (const invalid of [
    { ...sdk, expected: ["4.0.28", "4.0.29"] },
    { ...sdk, registered: ["4.0.29", "4.0.30"] },
    { ...sdk, registered: ["4.0.28", "4.0.28", "4.0.29"] },
  ]) {
    const list: SqlSchemaExpectation[] = [...valid];
    list[index] = invalid;
    assert.throws(() => validateSqlExpectations(list), /expectations-invalid/);
  }
});
