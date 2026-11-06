import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";

// The readiness triggers are installed and removed while the server's provisioning jobs keep
// writing the same tables, each job in its own order. A real local Postgres shows whether the two
// can deadlock.
const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
const { dropReadinessTriggers, installReadinessTriggers } = (await import(
  new URL("../../.upstream/apps/hosted/testing/provisioning-readiness-triggers.ts", import.meta.url)
    .href
)) as typeof import("../../.upstream/apps/hosted/testing/provisioning-readiness-triggers.ts");
const tables = [
  "hosted_provisioning",
  "organization",
  "executor_apps",
  "executor_accounts",
  "hosted_app_account_links",
];
const triggerCount =
  "select count(*)::int as count from pg_trigger where tgname like 'e2e\\_%' and not tgisinternal";

type Outcome = { readonly ok: true } | { readonly ok: false; readonly code: string | undefined };
const settled = (query: Promise<unknown>): Promise<Outcome> =>
  query.then(
    () => ({ ok: true }),
    (error: { code?: string }) => ({ ok: false, code: error.code }),
  );

/**
 * Runs `operation` on its own connection while a job holds the account table and then writes the
 * organization table, an earlier table of the trigger list, once the operation waits on the job.
 */
async function againstJob(
  operation: (client: pg.Client) => Promise<unknown>,
  prepare?: (client: pg.Client) => Promise<unknown>,
) {
  const database = `readiness_triggers_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  const job = new pg.Client({ connectionString: url.toString() });
  const client = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`create database ${database}`);
  try {
    await job.connect();
    await client.connect();
    await job.query(tables.map((table) => `create table ${table} (id text)`).join("; "));
    await prepare?.(client);
    // A job has written an account and has not committed yet.
    await job.query("begin");
    await job.query("insert into executor_accounts values ('account')");
    const [{ pid }] = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows;
    const result = settled(operation(client));
    let done = false;
    void result.then(() => (done = true));
    // Wait until the operation queues behind the job's lock, or ends without ever waiting.
    const deadline = Date.now() + 10_000;
    for (let waiting = false; !waiting && !done;) {
      assert.ok(Date.now() < deadline, "the operation neither waited on the job nor finished");
      const [{ count }] = (
        await admin.query<{ count: number }>(
          "select count(*)::int as count from pg_locks where pid = $1 and not granted",
          [pid],
        )
      ).rows;
      waiting = count > 0;
    }
    // Postgres aborts either side of a deadlock, so both outcomes are returned.
    const wrote = await settled(job.query("insert into organization values ('organization')"));
    await job.query(wrote.ok ? "commit" : "rollback");
    const outcomes = { operation: await result, job: wrote };
    const [{ count }] = (await client.query<{ count: number }>(triggerCount)).rows;
    return { outcomes, triggers: count };
  } finally {
    await job.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
}

const bothComplete = { operation: { ok: true }, job: { ok: true } };

test(
  "installing the readiness triggers never deadlocks a job that writes their tables in another order",
  { skip: !local, timeout: 30_000 },
  async () => {
    const { outcomes, triggers } = await againstJob(installReadinessTriggers);
    assert.deepEqual(outcomes, bothComplete, "the install and the job both complete");
    assert.equal(triggers, tables.length, "every input table has its trigger");
  },
);

test(
  "removing the readiness triggers never deadlocks a job that writes their tables in another order",
  { skip: !local, timeout: 30_000 },
  async () => {
    const { outcomes, triggers } = await againstJob(
      dropReadinessTriggers,
      installReadinessTriggers,
    );
    assert.deepEqual(outcomes, bothComplete, "the removal and the job both complete");
    assert.equal(triggers, 0, "no trigger is left behind");
  },
);
