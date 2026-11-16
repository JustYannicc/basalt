import assert from "node:assert/strict";
import { test } from "node:test";
import { StateStoreError } from "alchemy/State/State";
import { ReadOnlyStateStoreVersionMismatch } from "alchemy/State/ReadOnlyHttpStateStore";
import { SqlSchemaAuthorityFailure } from "./sql-schema-sources.ts";
import {
  schemaInspectionFailure,
  schemaInspectionFailureMessage,
} from "./schema-inspection-failure.ts";

test("a missing or revoked reader grant retains its HTTP status without provider text", () => {
  const failure = schemaInspectionFailure(
    new StateStoreError({ message: "Bearer private-state-secret", http: { status: 401 } }),
    "schema-inspection-state-unavailable",
  );
  assert.deepEqual(failure, {
    reason: "schema-inspection-state-unavailable",
    state: { httpStatus: 401 },
  });
  assert.match(schemaInspectionFailureMessage(failure), /HTTP=401/u);
  assert.doesNotMatch(JSON.stringify(failure), /Bearer|private-state-secret/u);
});

test("State version refusal records both bounded versions", () => {
  const failure = schemaInspectionFailure(
    new ReadOnlyStateStoreVersionMismatch(8, 7),
    "schema-inspection-state-unavailable",
  );
  assert.deepEqual(failure, {
    reason: "schema-inspection-state-version",
    state: { expectedVersion: 8, observedVersion: 7 },
  });
  assert.match(schemaInspectionFailureMessage(failure), /expected=8 observed=7/u);
});

test("migration authority refusals identify the resource, state and failed check", () => {
  const failure = schemaInspectionFailure(
    new SqlSchemaAuthorityFailure("Migrations", "updating-authority-drift", "updating"),
    "schema-inspection-authority-unavailable",
  );
  assert.deepEqual(failure, {
    reason: "schema-inspection-authority-unavailable",
    authority: { resource: "Migrations", check: "updating-authority-drift", status: "updating" },
  });
  assert.match(
    schemaInspectionFailureMessage(failure),
    /Migrations status=updating check=updating-authority-drift/u,
  );
});

test("unknown errors and out-of-bound HTTP/version numbers never expose their payload", () => {
  for (const error of [new Error("private-driver-payload"), { password: "private-payload" }])
    assert.deepEqual(schemaInspectionFailure(error, "schema-inspection-operation-failed"), {
      reason: "schema-inspection-operation-failed",
    });
  const failure = schemaInspectionFailure(
    new StateStoreError({ message: "private", http: { status: 123456 } }),
    "schema-inspection-state-unavailable",
  );
  assert.deepEqual(failure, { reason: "schema-inspection-state-unavailable" });
  assert.doesNotMatch(
    JSON.stringify(
      schemaInspectionFailure(
        new ReadOnlyStateStoreVersionMismatch(8, Number.POSITIVE_INFINITY),
        "schema-inspection-state-unavailable",
      ),
    ),
    /Infinity/u,
  );
});
