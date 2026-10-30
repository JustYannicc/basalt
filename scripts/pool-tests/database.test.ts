import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import pg from "pg";
import { poolDatabase } from "../../src/pool/database-settings.ts";
import { hasActiveHomeApiKey } from "../../src/pool/model-auth.ts";
import { managedMigrationUrl } from "./managed-postgres.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname)) {
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");
}

function provision(runtimeRole: string, migrationUrl: string): void {
  const result = spawnSync(process.execPath, ["scripts/ensure-pool-database.ts"], {
    env: { ...process.env, POOL_DATABASE_ADMIN_URL: migrationUrl, POOL_DATABASE_RUNTIME_ROLE: runtimeRole },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

test("logical database persists across runtime-role rotation and excludes unrelated logins", async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const migrationUrl = await managedMigrationUrl(admin, adminUrl!);
    for (const name of ["pool_test_first", "pool_test_second", "pool_test_outsider"]) {
      await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'fixture-only'`);
    }
    provision("pool_test_first", migrationUrl);
    function connection(role: string) {
      const url = new URL(adminUrl!);
      url.username = role;
      url.password = "fixture-only";
      url.pathname = `/${poolDatabase.name}`;
      url.searchParams.set("options", `-c role=${poolDatabase.owner}`);
      return new pg.Client({ connectionString: url.toString() });
    }
    const first = connection("pool_test_first");
    await first.connect();
    await first.query("CREATE TABLE pool_proof (value text NOT NULL)");
    await first.query("INSERT INTO pool_proof VALUES ('retained')");
    await first.query("CREATE TABLE api_key (api_key text NOT NULL UNIQUE, deleted_at timestamptz)");
    await first.query("INSERT INTO api_key VALUES ('active-key', NULL), ('revoked-key', now())");
    await first.end();

    // A PlanetScale login carries a branch routing suffix after the role name.
    provision("pool_test_second.fixturebranch", migrationUrl);
    const second = connection("pool_test_second");
    await second.connect();
    assert.deepEqual((await second.query("SELECT * FROM pool_proof")).rows, [{ value: "retained" }]);
    // Home's migrations must retain ownership across managed login rotation.
    await second.query("ALTER TABLE pool_proof ADD COLUMN migrated boolean DEFAULT true");
    await assert.rejects(second.query("CREATE DATABASE forbidden_pool_database"), { code: "42501" });
    await second.end();

    // Hyperdrive supplies the login and database without the container's SET ROLE option.
    const workerUrl = new URL(adminUrl!);
    workerUrl.username = "pool_test_second";
    workerUrl.password = "fixture-only";
    workerUrl.pathname = `/${poolDatabase.name}`;
    workerUrl.search = "";
    assert.equal(await hasActiveHomeApiKey(workerUrl.toString(), ["unknown-key", "active-key"]), true);
    assert.equal(await hasActiveHomeApiKey(workerUrl.toString(), ["active-key", "\0"]), true);
    await assert.rejects(hasActiveHomeApiKey(workerUrl.toString(), ["\0", "active-key"]), { code: "22021" });
    assert.equal(await hasActiveHomeApiKey(workerUrl.toString(), ["revoked-key"]), false);
    assert.equal(await hasActiveHomeApiKey(workerUrl.toString(), ["' OR TRUE --"]), false);

    const outsider = connection("pool_test_outsider");
    await assert.rejects(outsider.connect(), { code: "42501" });
    await outsider.end();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${poolDatabase.name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${poolDatabase.owner}`);
    await admin.query("DROP ROLE IF EXISTS pool_test_first, pool_test_second, pool_test_outsider");
    await admin.end();
  }
});
