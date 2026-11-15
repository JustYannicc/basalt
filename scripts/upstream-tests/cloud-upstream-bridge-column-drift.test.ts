import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Effect,
  SqlClient,
  pgliteLayer,
  seedHistory,
  journal,
  objects,
  retainedCloud,
  refused,
  migrateCloudProductSteps,
} from "./cloud-upstream-bridge-fixtures.ts";

for (const [statement, issue] of [
  [
    "alter table hosted_tool_policies alter column definition type text using definition::text",
    '10_tool_policies: hosted_tool_policies.definition.type: expected "jsonb", observed "text"',
  ],
  [
    "alter table cloud_billing_seats alter column seat_plan drop not null",
    '2_billing_seats: cloud_billing_seats.seat_plan.nullable: expected "NO", observed "YES"',
  ],
  [
    "alter table cloud_company_profile alter column attempts set default 7",
    '1_baseline: cloud_company_profile.attempts.default: expected "0", observed "7"',
  ],
  [
    "alter table cloud_welcome_email alter column status set default 'public.pending'",
    "1_baseline: cloud_welcome_email.status.default: expected \"'pending'::text\", observed \"'public.pending'::text\"",
  ],
] as const) {
  test(`recorded column drift refuses without altering retained state: ${issue}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedHistory(19);
        yield* sql.unsafe(statement);
        const before = {
          journal: yield* journal,
          objects: yield* objects,
          retained: yield* retainedCloud,
        };
        const error = yield* refused(migrateCloudProductSteps());
        assert.ok(error.lineageIssues?.includes(issue), error.message);
        assert.deepEqual(
          { journal: yield* journal, objects: yield* objects, retained: yield* retainedCloud },
          before,
        );
      }).pipe(Effect.provide(pgliteLayer())),
    );
  });
}
