import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Effect,
  SqlClient,
  pgliteLayer,
  cloudMigrationSteps,
  migrateCloudProductSteps,
  migrateProductSteps,
  expectedIds,
  seedHistory,
  journal,
  objects,
  refused,
} from "./cloud-upstream-bridge-fixtures.ts";

for (const id of expectedIds.slice(0, -1))
  test(`a higher ledger cannot conceal missing Cloud operation ${id}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedHistory(19);
        yield* sql`delete from private_cloud_migrations where migration_id = ${id}`;
        const before = { journal: yield* journal, objects: yield* objects };
        const error = yield* refused(migrateCloudProductSteps());
        const key = Object.keys(cloudMigrationSteps).find((name) => Number.parseInt(name) === id)!;
        assert.ok(
          error.lineageIssues?.includes(
            `private_cloud_migrations: missing ${key} below recorded maximum 19`,
          ),
          error.message,
        );
        assert.deepEqual(yield* journal, before.journal);
        assert.deepEqual(yield* objects, before.objects);
      }).pipe(Effect.provide(pgliteLayer())),
    );
  });

test("unknown and mixed upstream journal meanings name every conflicting operation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedHistory(10);
      yield* sql`update private_cloud_migrations set name = 'v1_session_handoffs' where migration_id = 8`;
      yield* sql`update private_cloud_migrations set name = 'v1_import_allowed' where migration_id = 9`;
      yield* sql`update private_cloud_migrations set name = 'setup_skip_assignments' where migration_id = 10`;
      yield* sql`insert into private_cloud_migrations (migration_id, name) values
      (11, 'v1_import_billing'), (12, 'v1_import_displacement'), (13, 'v1_import_into'), (20, 'unknown_operation')`;
      const before = { journal: yield* journal, objects: yield* objects };
      const error = yield* refused(migrateCloudProductSteps());
      for (const operation of [
        "8_v1_session_handoffs",
        "9_v1_import_allowed",
        "10_setup_skip_assignments",
        "11_v1_import_billing",
        "12_v1_import_displacement",
        "13_v1_import_into",
        "20_unknown_operation",
      ])
        assert.ok(
          error.lineageIssues?.some((issue) => issue.includes(operation)),
          error.message,
        );
      assert.match(error.message, /expected 8_production_ops_receipts/);
      assert.match(error.message, /expected 9_production_ops_database_identity/);
      assert.match(error.message, /expected 10_tool_policies/);
      assert.deepEqual(yield* journal, before.journal);
      assert.deepEqual(yield* objects, before.objects);
    }).pipe(Effect.provide(pgliteLayer())),
  );
});

for (const [statement, missing] of [
  [
    "drop table private_production_ops_receipts",
    "8_production_ops_receipts: missing private_production_ops_receipts.plan_sha256",
  ],
  [
    "drop table production_ops_database_identity",
    "9_production_ops_database_identity: missing production_ops_database_identity.id",
  ],
  [
    "delete from production_ops_database_identity",
    "9_production_ops_database_identity: expected exactly one retained UUID",
  ],
  [
    "drop table hosted_tool_policy_history",
    "10_tool_policies: missing hosted_tool_policy_history.sequence",
  ],
  [
    "drop table private_v1_import_allowed",
    "15_v1_import_allowed: missing private_v1_import_allowed.v1_org_id",
  ],
  [
    "drop table private_v1_import_billing",
    "17_v1_import_billing: missing private_v1_import_billing.organization_id",
  ],
  [
    "drop table cloud_setup_skip_assignment",
    "16_setup_skip_assignments: missing cloud_setup_skip_assignment.user_id",
  ],
  [
    "alter table private_v1_import_allowed drop column displace_v2_org_id",
    "18_v1_import_displacement: missing private_v1_import_allowed.displace_v2_org_id",
  ],
  [
    "alter table private_v1_import_allowed drop column into_mode",
    "19_v1_import_into: missing private_v1_import_allowed.into_mode",
  ],
  [
    "alter table private_v1_import_allowed alter column into_mode set default 'unexpected'",
    "19_v1_import_into: private_v1_import_allowed.into_mode.default: expected null, observed",
  ],
  [
    "drop index private_v1_session_handoff_expires",
    "14_v1_session_handoffs: missing valid index private_v1_session_handoff_expires",
  ],
] as const)
  test(`a recorded operation with missing SQL refuses: ${missing}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedHistory(19);
        yield* sql.unsafe(statement);
        const before = { journal: yield* journal, objects: yield* objects };
        const error = yield* refused(migrateCloudProductSteps());
        assert.ok(
          error.lineageIssues?.some((issue) => issue.startsWith(missing)),
          error.message,
        );
        assert.deepEqual(yield* journal, before.journal);
        assert.deepEqual(yield* objects, before.objects);
      }).pipe(Effect.provide(pgliteLayer())),
    );
  });

test("unrecorded upstream-shaped tables are refused instead of adopted", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedHistory(10);
      yield* cloudMigrationSteps["14_v1_session_handoffs"];
      yield* cloudMigrationSteps["15_v1_import_allowed"];
      const error = yield* refused(migrateCloudProductSteps());
      assert.match(
        error.message,
        /14_v1_session_handoffs: unjournaled private_v1_session_handoff.jti/,
      );
      assert.match(
        error.message,
        /15_v1_import_allowed: unjournaled private_v1_import_allowed.v1_org_id/,
      );
      assert.equal((yield* journal).at(-1)?.migration_id, 10);
      assert.deepEqual(yield* sql`select count(*)::int as count from private_v1_import_allowed`, [
        { count: 0 },
      ]);
    }).pipe(Effect.provide(pgliteLayer())),
  );
});

test("an index with the expected name and the wrong definition is refused", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedHistory(19);
      yield* sql`drop index private_v1_session_handoff_expires`;
      yield* sql`create index private_v1_session_handoff_expires on private_v1_session_handoff (jti)`;
      const error = yield* refused(migrateCloudProductSteps());
      assert.match(
        error.message,
        /14_v1_session_handoffs: changed definition of index private_v1_session_handoff_expires/,
      );
    }).pipe(Effect.provide(pgliteLayer())),
  );
});

test("unjournaled policy tables require their shared Hosted 16 owner", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedHistory(9);
      yield* cloudMigrationSteps["10_tool_policies"];
      const error = yield* refused(migrateCloudProductSteps());
      assert.match(error.message, /10_tool_policies: unjournaled hosted_tool_policies.id/);
      assert.equal((yield* journal).at(-1)?.migration_id, 9);
    }).pipe(Effect.provide(pgliteLayer())),
  );
});

test("the shared runner refuses hosted holes and changed meanings with exact names", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const steps = { "1_baseline": Effect.void, "2_api_key_memberships": Effect.void };
      yield* migrateProductSteps("private_hosted_migrations", steps);
      yield* sql`delete from private_hosted_migrations where migration_id = 1`;
      yield* sql`update private_hosted_migrations set name = 'unexpected_meaning' where migration_id = 2`;
      const error = yield* refused(migrateProductSteps("private_hosted_migrations", steps));
      assert.match(
        error.message,
        /private_hosted_migrations: missing 1_baseline below recorded maximum 2/,
      );
      assert.match(error.message, /2_unexpected_meaning observed; expected 2_api_key_memberships/);
    }).pipe(Effect.provide(pgliteLayer())),
  );
});

for (const status of ["PENDING", "public.pending"]) {
  test(`index predicates preserve quoted literal bytes: ${status}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedHistory(19);
        yield* sql`drop index cloud_welcome_email_pending`;
        yield* sql.unsafe(
          "create index cloud_welcome_email_pending on cloud_welcome_email (created_at, user_id) where status = '" +
            status +
            "'",
        );
        const error = yield* refused(migrateCloudProductSteps());
        assert.match(
          error.message,
          /1_baseline: changed definition of index cloud_welcome_email_pending/,
        );
        assert.ok(error.message.includes(status), error.message);
      }).pipe(Effect.provide(pgliteLayer())),
    );
  });
}
