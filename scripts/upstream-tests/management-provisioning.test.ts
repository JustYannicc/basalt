import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Client, Pool } from "pg";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import {
  awaitManagementProvisioning,
  installManagementNotifications,
} from "../../.upstream/apps/hosted/testing/management-provisioning.ts";

const deferred = <A>() => Promise.withResolvers<A>();

const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;

/** A disposable database on the declared PostgreSQL prerequisite that check:upstream provides. */
async function realDatabase() {
  assert.ok(
    adminUrl && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname),
    "MIGRATION_TEST_ADMIN_URL must name an isolated loopback PostgreSQL database",
  );
  const name = `management_provisioning_${randomBytes(5).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  return {
    url: target.toString(),
    close: async () => {
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

test("pool readiness waits for its committed deployment, account and link, without unrelated jobs", async () => {
  const fixture = await realDatabase();
  const database = new Pool({ connectionString: fixture.url, max: 1 });
  const watcher = new Client({ connectionString: fixture.url });
  await watcher.connect();
  try {
    await watcher.query(`create table organization(id text, metadata jsonb);
      create table executor_accounts(id text, owner text);
      create table executor_apps(id text, owner text, active_deployment text);
      create table hosted_app_account_links(account text, app text);
      create table hosted_provisioning(id text, organization_id text, user_id text, status text);
      insert into organization values ('team', '{"executorDefaults":{"installed":true,"app":"app"},"executorKeyAccounts":{"person":"account"}}');
      insert into executor_accounts values ('account', 'organization:team');
      insert into executor_apps values ('pool', 'organization:team', 'version');
      insert into hosted_app_account_links values ('account', 'app');
      insert into hosted_provisioning values ('unrelated', 'team', null, 'running');`);
    await installManagementNotifications(database);
    const waiting = awaitManagementProvisioning(
      database,
      "team",
      "person",
      // The code's own cancellation bounds the wait if the notification never comes.
      AbortSignal.timeout(30_000),
      false,
      true,
    );
    // The waiter has read once and now waits on its notification: its session is idle, and the
    // readiness select is the last statement it ran. It stays that way, the same statement end
    // on the same session, so it is neither past its last read nor reading again on its own.
    const settled = async () =>
      (
        await watcher.query<{ pid: number; changed: string }>(
          `select pid, state_change::text as changed from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and state = 'idle' and query like 'select coalesce(%'`,
        )
      ).rows;
    let first: { pid: number; changed: string } | undefined;
    for (let attempt = 0; attempt < 5_000 && !first; attempt++) first = (await settled())[0];
    assert.ok(first, "The waiter never read and settled on its notification");
    for (let observation = 0; observation < 200; observation++)
      assert.deepEqual(await settled(), [first], "The waiter read again without a notification");
    // With a pool of one, the waiter still holds the only client while it waits.
    assert.equal(database.idleCount, 0);
    // One commit adds the pool's account, its link and its declaration, and wakes the waiter.
    await watcher.query(`begin;
      insert into executor_accounts values ('pool-account', 'organization:team');
      insert into hosted_app_account_links values ('pool-account', 'pool');
      update organization set metadata = metadata || '{"basaltPools":{"person":{"app":"pool","version":"version","account":"pool-account"}}}'::jsonb;
      commit;`);
    // It returns only once a read after this commit finds everything committed.
    await waiting;
    // The waiter returned its client to the pool, without the notification listener.
    assert.equal(database.totalCount, 1);
    assert.equal(database.idleCount, 1);
    const returned = await database.connect();
    assert.equal(returned.listenerCount("notification"), 0);
    returned.release();
  } finally {
    await database.end();
    await watcher.end();
    await fixture.close();
  }
});

for (const settled of [false, true])
  for (const subject of ["organization", "user"] as const)
    test(
      `setup ${settled ? "waits" : "does not wait"} for ${subject} jobs after management links exist`,
      { timeout: 10_000 },
      async (context) => {
        const sql = new PGlite();
        const database = new Pool();
        const releases: (Error | boolean | undefined)[] = [];
        const client = Object.assign(new Client(), {
          release: (error?: Error | boolean) => releases.push(error),
        });
        let reads = 0;
        context.mock.method(database, "connect", async () => client);
        context.mock.method(
          client,
          "query",
          async (text: string, values?: (string | boolean)[]) => {
            if (text.startsWith("listen ") || text.startsWith("unlisten ")) return { rows: [] };
            const result = await sql.query<{ ready: boolean }>(text, values);
            reads++;
            if (reads === 1) {
              assert.deepEqual(
                result.rows,
                [{ ready: !settled }],
                "only a settled setup waits beyond the committed management link",
              );
              if (settled) {
                await sql.exec(
                  "update hosted_provisioning set status = 'succeeded' where id = 'held'",
                );
                // Completion during the snapshot read must wake the subscribed waiter too.
                client.emit("notification", { channel: "e2e_management_provisioned", payload: "" });
              }
            }
            return result;
          },
        );
        try {
          await sql.exec(`create table organization(id text, metadata jsonb);
        create table executor_accounts(id text, owner text);
        create table executor_apps(id text, owner text, active_deployment text);
        create table hosted_app_account_links(account text, app text);
        create table hosted_provisioning(id text, organization_id text, user_id text, status text);
        insert into organization values ('team', '{"executorDefaults":{"installed":true,"app":"app"},"executorKeyAccounts":{"person":"account"}}');
        insert into executor_accounts values ('account', 'organization:team');
        insert into hosted_app_account_links values ('account', 'app');
        insert into hosted_provisioning values ('unrelated', 'other-team', 'other-person', 'running');`);
          await sql.query("insert into hosted_provisioning values ('held', $1, $2, 'running')", [
            subject === "organization" ? "team" : null,
            subject === "user" ? "person" : null,
          ]);
          if (settled)
            await awaitManagementProvisioning(
              database,
              "team",
              "person",
              new AbortController().signal,
              true,
            );
          else
            await awaitManagementProvisioning(
              database,
              "team",
              "person",
              new AbortController().signal,
            );
          assert.equal(reads, settled ? 2 : 1);
          assert.deepEqual(releases, [false]);
          assert.equal(client.listenerCount("notification"), 0);
        } finally {
          await database.end();
          await sql.close();
        }
      },
    );

for (const held of ["listen", "readiness", "unlisten"] as const)
  test(
    `setup abort releases its client while ${held} is held`,
    { timeout: 5_000 },
    async (context) => {
      const database = new Pool();
      const releases: (Error | boolean | undefined)[] = [];
      const client = Object.assign(new Client(), {
        release: (error?: Error | boolean) => {
          releases.push(error);
        },
      });
      const entered = deferred<void>();
      const queryHeld = deferred<{ rows: { ready: boolean }[] }>();
      context.mock.method(database, "connect", async () => client);
      context.mock.method(client, "query", async (text: string) => {
        const operation = text.startsWith("listen ")
          ? "listen"
          : text.startsWith("unlisten ")
            ? "unlisten"
            : "readiness";
        if (operation === held) {
          entered.resolve();
          return queryHeld.promise;
        }
        return { rows: [{ ready: true }] };
      });
      const signal = new AbortController();
      const pending = awaitManagementProvisioning(database, "organization", "user", signal.signal);
      const rejected = assert.rejects(pending, { _tag: "ManagementProvisioningFailed" });
      try {
        await entered.promise;
        signal.abort();
        await rejected;
        assert.deepEqual(releases, [true], "discard the client before the held query settles");
        assert.equal(client.listenerCount("notification"), 0);
        assert.equal(client.listenerCount("error"), 0);
      } finally {
        queryHeld.resolve({ rows: [{ ready: true }] });
        await Promise.allSettled([pending]);
        await database.end();
      }
    },
  );

test(
  "setup abort rejects a held checkout and disposes its late client",
  { timeout: 5_000 },
  async (context) => {
    const database = new Pool();
    const releases: (Error | boolean | undefined)[] = [];
    const client = Object.assign(new Client(), {
      release: (error?: Error | boolean) => {
        releases.push(error);
      },
    });
    const acquisition = deferred<typeof client>();
    const entered = deferred<void>();
    context.mock.method(database, "connect", () => {
      entered.resolve();
      return acquisition.promise;
    });
    const query = context.mock.method(client, "query");
    const signal = new AbortController();
    const pending = awaitManagementProvisioning(database, "organization", "user", signal.signal);
    const rejected = assert.rejects(pending, { _tag: "ManagementProvisioningFailed" });
    try {
      await entered.promise;
      signal.abort();
      await rejected;
      assert.deepEqual(releases, []);
      acquisition.resolve(client);
      // The helper's already-registered checkout callback runs before this continuation.
      await acquisition.promise;
      assert.deepEqual(releases, [true]);
      assert.equal(query.mock.callCount(), 0);
    } finally {
      acquisition.resolve(client);
      await Promise.allSettled([pending]);
      await database.end();
    }
  },
);

test("an already-aborted setup never acquires a client", async (context) => {
  const database = new Pool();
  const connect = context.mock.method(database, "connect");
  const signal = new AbortController();
  signal.abort();
  try {
    await assert.rejects(
      awaitManagementProvisioning(database, "organization", "user", signal.signal),
      { _tag: "ManagementProvisioningFailed" },
    );
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    await database.end();
  }
});
