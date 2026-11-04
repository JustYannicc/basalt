import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const require = createRequire(
  new URL("../../.upstream/apps/hosted/cloud/package.json", import.meta.url),
);
const { PGlite } = await import(require.resolve("@electric-sql/pglite"));
const source = readFileSync(
  new URL(
    "../../.upstream/apps/hosted/testing/production-ops-provisioning-fixture.ts",
    import.meta.url,
  ),
  "utf8",
);
const readiness = source.match(/await client\.query\(\s*`(with[\s\S]*?)`/u)?.[1];
assert.ok(readiness, "use the fixture's actual SQL readiness check");

const fixture = async () => {
  const database = new PGlite();
  await database.exec(`
    create table hosted_provisioning (kind text, status text);
    create table organization (id text, metadata jsonb);
    create table member ("organizationId" text, "userId" text, role text);
    create table "user" (id text, "emailVerified" boolean);
    create table executor_accounts (id text, owner text, method text);
    create table executor_apps (id text, owner text, active_deployment text);
    create table hosted_app_account_links (app text, account text, requirement text, subject text);
    insert into hosted_provisioning values ('user', 'succeeded'), ('member', 'running');
    insert into organization values ('team', '{"executorDefaults":{"installed":true},"executorKeyAccounts":{"person":"key"}}');
    insert into member values ('team', 'person', 'owner');
    insert into "user" values ('person', true);
    insert into executor_accounts values ('key', 'organization:team', 'apiKey');
  `);
  const observe = async (pools = true) => {
    const { rows } = await database.query(readiness, readiness.includes("$1") ? [pools] : []);
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0]?.pending, "number");
    assert.equal(typeof rows[0]?.failed, "number");
    return rows[0]!;
  };
  return { database, observe };
};

test("ready default keys do not release the physical fixture while pool work is pending", async () => {
  const { database, observe } = await fixture();
  try {
    assert.equal((await observe(false)).pending, 0);
    assert.equal((await observe()).pending, 1);
    await database.exec(`
      insert into executor_apps values ('pool', 'organization:team', 'version');
      update organization set metadata = metadata || '{"basaltPools":{"pool":{"app":"pool","version":"version","owner":"person","account":"token"}}}';
    `);
    assert.equal((await observe()).pending, 1, "recorded intent is not a committed account");
    await database.exec(
      "insert into executor_accounts values ('token', 'organization:team', 'token')",
    );
    assert.equal((await observe()).pending, 1, "the account must also be linked");
    await database.exec(
      "insert into hosted_app_account_links values ('pool', 'token', 'pool', null)",
    );
    assert.equal(
      (await observe()).pending,
      0,
      "committed pool setup releases readiness even when a later member step is running",
    );
  } finally {
    await database.close();
  }
});

test("clone readiness still accepts deliberately synthetic pool metadata after the early drain", async () => {
  const { database, observe } = await fixture();
  try {
    await database.exec(
      `update organization set metadata = metadata || '{"basaltPools":{"fixture":{"app":"synthetic"}}}'`,
    );
    assert.equal((await observe(false)).pending, 0);
    assert.equal((await observe()).pending, 1);
  } finally {
    await database.close();
  }
});
