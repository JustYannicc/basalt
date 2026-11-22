import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProductMigrationMarkers } from "./sql-schema-expectations.ts";

const cloud = `
  import { migrateCloudProductSteps as runCloudProductSteps } from "./cloud-migration-runner.ts";
  export const cloudMigrationSteps = { "1_baseline": run, "19_v1_import_into": run };
  export const migrateCloudProductSteps = (steps: Record<string, unknown> = cloudMigrationSteps) =>
    runCloudProductSteps(steps);
  migrateCloudProductSteps();
`;
const cloudRunner = `
  import { Effect } from "effect";
  import { SqlClient } from "effect/sql";
  import { migrateProductSteps, migrationFailed } from "@executor-js/hosted-server/migrations";
  export const migrateCloudProductSteps = (steps: Record<string, unknown>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const verify = Effect.gen(function* () { Object.keys(steps); });
      yield* sql.withTransaction(verify.pipe(
        Effect.andThen(migrateProductSteps("private_cloud_migrations", steps)),
        Effect.andThen(verify),
      ));
    }).pipe(Effect.mapError(migrationFailed("product")));
`;

test("Cloud extraction follows the exported default literal through its imported runner", () => {
  assert.deepEqual(parseProductMigrationMarkers(cloud, "private_cloud_migrations", cloudRunner), [
    "1_baseline",
    "19_v1_import_into",
  ]);
});

for (const [name, source, runner] of [
  ["missing runner evidence", cloud, undefined],
  ["wrong import", cloud.replace("./cloud-migration-runner.ts", "./other.ts"), cloudRunner],
  [
    "wrong runner import",
    cloud,
    cloudRunner.replace("@executor-js/hosted-server/migrations", "other"),
  ],
  ["wrong journal", cloud, cloudRunner.replace("private_cloud_migrations", "other")],
  [
    "wrong forwarded registry",
    cloud,
    cloudRunner.replace('"private_cloud_migrations", steps', '"private_cloud_migrations", other'),
  ],
  [
    "duplicate runner call",
    cloud,
    cloudRunner + 'migrateProductSteps("private_cloud_migrations", steps);',
  ],
  ["duplicate delegation", cloud + "runCloudProductSteps(cloudMigrationSteps);", cloudRunner],
  [
    "explicit override",
    cloud.replace("migrateCloudProductSteps();", "migrateCloudProductSteps(other);"),
    cloudRunner,
  ],
  ["indirect default", cloud.replace("= cloudMigrationSteps)", "= indirect)"), cloudRunner],
  [
    "non-literal default",
    cloud.replace(
      'export const cloudMigrationSteps = { "1_baseline": run, "19_v1_import_into": run };',
      "export const cloudMigrationSteps = dynamic();",
    ),
    cloudRunner,
  ],
  [
    "mutable default",
    cloud.replace("const cloudMigrationSteps", "let cloudMigrationSteps"),
    cloudRunner,
  ],
  [
    "wrong wrapper argument",
    cloud.replace("runCloudProductSteps(steps)", "runCloudProductSteps(other)"),
    cloudRunner,
  ],
  [
    "extra wrapper argument",
    cloud.replace("runCloudProductSteps(steps)", "runCloudProductSteps(steps, other)"),
    cloudRunner,
  ],
  [
    "non-exported wrapper",
    cloud.replace("export const migrateCloudProductSteps", "const migrateCloudProductSteps"),
    cloudRunner,
  ],
  [
    "decoy journal call",
    cloud,
    cloudRunner.replace('migrateProductSteps("private_cloud_migrations", steps)', "other(steps)") +
      'migrateProductSteps("private_cloud_migrations", steps);',
  ],
  ["default registry mutation", cloud + 'cloudMigrationSteps["20_extra"] = run;', cloudRunner],
  [
    "dead nested helper",
    cloud,
    cloudRunner.slice(0, cloudRunner.indexOf("export const")) +
      `
    export const migrateCloudProductSteps = (steps: Record<string, unknown>) => {
      const unused = () => migrateProductSteps("private_cloud_migrations", steps);
      return Effect.void;
    };`,
  ],
  ["untransactional forwarding", cloud, cloudRunner.replace("sql.withTransaction", "sql.other")],
  [
    "unexecuted transaction",
    cloud,
    cloudRunner.replace("yield* sql.withTransaction", "sql.withTransaction"),
  ],
  [
    "early return",
    cloud,
    cloudRunner.replace("yield* sql.withTransaction", "return; yield* sql.withTransaction"),
  ],
  ["registry mutation", cloud, cloudRunner.replace("Object.keys(steps);", "steps.extra = run;")],
] as const) {
  test(`Cloud extraction refuses ${name}`, () => {
    assert.throws(
      () => parseProductMigrationMarkers(source, "private_cloud_migrations", runner),
      /sql-schema-expectations-invalid/,
    );
  });
}
