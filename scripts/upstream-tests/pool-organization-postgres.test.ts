import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { test } from "node:test";
import { PgClient, PgPool } from "@effect/sql-pg";
import * as PgConnection from "@effect/sql-pg/PgConnection";
import { ConfigProvider, Effect, Logger, ManagedRuntime, Redacted } from "effect";
import { HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import pg from "pg";
import { StatementBatch } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { OrganizationTombstones } from "../../.upstream/apps/hosted/server/src/contracts/organization-removal.ts";
import {
  poolOrganizationReadPath,
  readPoolOrganization,
} from "../../.upstream/apps/hosted/server/src/implementation/pool-organization.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { postgresUrl } from "./org-lock-postgres-fixture.ts";

const signingKey = "ab".repeat(32);
const person = "org_person";
const pool = "app_person_pool";
const application = `ownership-${randomUUID().slice(0, 8)}`;

/** Each way's delay on the proxy: a database a Worker reaches over the network, not on loopback. */
const linkDelayMs = 25;

/**
 * A proxy to the test database that never forwards a cancel request, as a Worker's socket that
 * closed with the response never sends one: only the database itself can end a cut read. Every chunk
 * waits `linkDelayMs` each way, in order, as a database a Worker reaches over the network.
 */
async function withoutCancels(target: URL) {
  const relay = (from: net.Socket, to: net.Socket) =>
    from.on("data", (chunk: Buffer) =>
      setTimeout(() => to.writable && to.write(chunk), linkDelayMs),
    );
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("data", (first: Buffer) => {
      // A cancel request is 16 bytes: its length, then the code 80877102.
      if (first.length >= 8 && first.readUInt32BE(0) === 16 && first.readUInt32BE(4) === 80877102)
        return;
      const upstream = net.connect(Number(target.port || 5432), target.hostname, () => {
        setTimeout(() => upstream.write(first), linkDelayMs);
        relay(client, upstream);
        relay(upstream, client);
      });
      sockets.add(upstream);
      for (const [a, b] of [
        [client, upstream],
        [upstream, client],
      ] as const) {
        a.on("error", () => b.destroy());
        a.on("close", () => b.destroy());
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxied = new URL(target);
  proxied.hostname = "127.0.0.1";
  proxied.port = String((server.address() as net.AddressInfo).port);
  return {
    url: proxied.toString(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * One Worker event's pool. `grouped` is Cloud's event pool on the ownership route: it leases one
 * connection at a time and groups statements, and the route sends its batch in one write as one
 * read-only transaction (main.ts). `plain` is every other route's pool, which the ownership route
 * also gets when its event built the pool before the route asked for groups.
 */
type Mode = "plain" | "grouped";
const modes: ReadonlyArray<Mode> = ["plain", "grouped"];
const eventPool = (url: string, schema: string, mode: Mode, maxConnections = 2) =>
  ManagedRuntime.make(
    PgClient.layer({
      url: Redacted.make(url),
      maxConnections,
      applicationName: application,
      startupParameters: { search_path: schema },
      // As the cloud's own pool, which sends no named statements.
      prepare: false,
      ...(mode === "grouped" ? { multiplex: true, multiplexConcurrency: 1 } : {}),
    }),
  );

/** One check through the route on `runtime`, with every line it wrote. */
async function checkOn(
  runtime: ReturnType<typeof eventPool>,
  mode: Mode,
  organization = person,
  poolId = pool,
) {
  const now = Date.now();
  const envelope = await signEnvelope(signingKey, "sbq1", {
    pool: poolId,
    organization,
    at: now,
    expiresAt: now + 30_000,
  });
  const lines: string[] = [];
  const logger = Logger.make(({ message }) => {
    const [text, fields] = Array.isArray(message) ? message : [message];
    const { reason, shape } = (fields ?? {}) as { reason?: unknown; shape?: unknown };
    const detail = reason ?? shape;
    lines.push(detail === undefined ? String(text) : `${String(text)}: ${String(detail)}`);
  });
  const started = performance.now();
  const response = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* SqlClient.SqlClient;
      const route = readPoolOrganization.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://tools${poolOrganizationReadPath}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ envelope }),
            }),
          ),
        ),
        Effect.provideService(GroupDatabase, Effect.succeed(db)),
        Effect.provideService(OrganizationTombstones, () => Effect.succeed(false)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { POOL_APP_SIGNING_KEY: signingKey } }),
        ),
        Effect.provide(Logger.layer([logger])),
      );
      // Cloud's route always hands over its batch; only the event's pool decides whether it is
      // used. A plain pool (one built before the route asked for groups) must fall back.
      return yield* route.pipe(
        Effect.provideService(StatementBatch, (leaves, { outside }) =>
          PgPool.held(
            PgConnection.pipelined(leaves, {
              outside,
              begin: "ISOLATION LEVEL REPEATABLE READ READ ONLY",
            }),
          ),
        ),
      );
    }),
  );
  return { status: response.status, ms: performance.now() - started, lines };
}

/** One check on its own small pool, as one Worker event has, closed after the answer. */
async function check(url: string, schema: string, mode: Mode) {
  const runtime = eventPool(url, schema, mode);
  const answer = await checkOn(runtime, mode);
  // The event's cleanup closes its pool after the response, as the Worker's does.
  await runtime.dispose();
  return answer;
}

/** Backends of this test's pools in any state: running, waiting, idle or aborted in a transaction. */
async function held(admin: pg.Client) {
  const { rows } = await admin.query(
    "select count(*)::int as n from pg_stat_activity where application_name = $1",
    [application],
  );
  return rows[0].n as number;
}

/** A schema of its own holding the route's two tables, behind a proxy that drops cancels. */
async function withDatabase(
  work: (context: {
    admin: pg.Client;
    locker: pg.Client;
    schema: string;
    url: string;
  }) => Promise<void>,
  // Metadata stored as jsonb: the rule's cast works, but `pg_input_is_valid(jsonb, …)` does not
  // exist, so only the shape read fails, as on a database without that function.
  { jsonbMetadata = false } = {},
) {
  const adminUrl = postgresUrl();
  const schema = `ownership_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  const locker = new pg.Client({ connectionString: adminUrl });
  await Promise.all([admin.connect(), locker.connect()]);
  const proxy = await withoutCancels(new URL(adminUrl));
  try {
    await admin.query(`create schema ${schema}`);
    await admin.query(`set search_path = ${schema}`);
    await admin.query(
      `create table organization (id text primary key, metadata ${jsonbMetadata ? "jsonb" : "text"})`,
    );
    await admin.query(
      "create table executor_apps (id text primary key, owner text not null, active_deployment text)",
    );
    const record = (app: string) =>
      JSON.stringify({ basaltPools: { [app]: { app, membership: "executor-links-v1" } } });
    for (const [organization, metadata, app] of [
      [person, record(pool), pool],
      ["org_other", record("app_unrelated"), "app_other_pool"],
      ...(jsonbMetadata ? [] : [["org_unreadable", "{ not json", "app_unreadable_pool"]]),
    ]) {
      await admin.query("insert into organization values ($1, $2)", [organization, metadata]);
      await admin.query("insert into executor_apps values ($1, $2, $3)", [
        app,
        `organization:${organization}`,
        `dpl_${app}`,
      ]);
    }
    await work({ admin, locker, schema, url: proxy.url });
  } finally {
    // The lock goes first, so a failed run can still clean up after itself.
    await locker.query("rollback").catch(() => {});
    await proxy.close();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await Promise.all([admin.end(), locker.end()]);
  }
}

for (const mode of modes)
  test(`a read stuck behind a lock ends in the database at its bound as a 503, and keeps no connection (${mode} pool)`, async () => {
    await withDatabase(async ({ admin, locker, schema, url }) => {
      assert.equal((await check(url, schema, mode)).status, 204);
      // A migration holds the apps table: every ownership read now waits on its lock.
      await locker.query("begin");
      await locker.query(`lock table ${schema}.executor_apps in access exclusive mode`);
      const answers = await Promise.all(Array.from({ length: 24 }, () => check(url, schema, mode)));
      for (const answer of answers) {
        // Unavailable, never refused: a read that did not complete says nothing about ownership.
        assert.equal(answer.status, 503);
        assert.deepEqual(answer.lines, ["Pool organization ownership not observed: timeout"]);
        // The database ends the read at 8 s, before the pool Worker gives up at 10 s, so the answer
        // is the tools service's own.
        assert.ok(answer.ms >= 7_900 && answer.ms < 10_000, String(answer.ms));
      }
      // No cancel reaches the database, and each read ended its own transaction: no connection is
      // left running, waiting, or aborted in it.
      const deadline = performance.now() + 1_000;
      while ((await held(admin)) > 0 && performance.now() < deadline);
      assert.equal(await held(admin), 0, "an ended ownership read still holds its connection");
      await locker.query("rollback");
      // The next request gets a connection without waiting on the ended ones.
      const next = await check(url, schema, mode);
      assert.equal(next.status, 204);
      assert.ok(next.ms < 1_000, String(next.ms));
    });
  });

for (const mode of modes)
  test(`a read that waits a second on a lock still answers, as on a slow database (${mode} pool)`, async () => {
    await withDatabase(async ({ locker, schema, url }) => {
      await locker.query("begin");
      await locker.query(`lock table ${schema}.executor_apps in access exclusive mode`);
      const answering = check(url, schema, mode);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await locker.query("rollback");
      const answer = await answering;
      assert.deepEqual([answer.status, answer.lines], [204, []]);
      assert.ok(answer.ms >= 1_000, String(answer.ms));
    });
  });

test("the route answers and reports the same on the grouped pool as on a plain one", async () => {
  await withDatabase(async ({ schema, url }) => {
    const cases = [
      [person, pool, 204, []],
      ["org_other", pool, 403, ["Pool organization refused: other-organization"]],
      [
        "org_unreadable",
        "app_unreadable_pool",
        503,
        ["Pool organization would be refused: invalid-metadata"],
      ],
      ["org_missing", pool, 403, []],
      // One organization's unreadable metadata leaves another's pool as it was.
      [person, pool, 204, []],
    ] as const;
    for (const mode of modes) {
      const runtime = eventPool(url, schema, mode);
      try {
        for (const [organization, poolId, status, lines] of cases) {
          const answer = await checkOn(runtime, mode, organization, poolId);
          assert.deepEqual(
            [answer.status, answer.lines],
            [status, lines],
            `${mode} ${organization} ${poolId}`,
          );
        }
      } finally {
        await runtime.dispose();
      }
    }
  });
});

test("a statement that fails inside the batch leaves the event's connection clean for the next one", async () => {
  await withDatabase(async ({ schema, url }) => {
    // One connection, so every statement after the batch runs on the connection the batch used.
    const runtime = eventPool(url, schema, "grouped", 1);
    try {
      // The rule's cast fails inside the batch's transaction; a second flight reads why.
      const failed = await checkOn(runtime, "grouped", "org_unreadable", "app_unreadable_pool");
      assert.deepEqual(
        [failed.status, failed.lines],
        [503, ["Pool organization would be refused: invalid-metadata"]],
      );
      const next = await checkOn(runtime, "grouped", "org_other", pool);
      assert.deepEqual(
        [next.status, next.lines],
        [403, ["Pool organization refused: other-organization"]],
      );
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [settings] = yield* sql<{
            statement_timeout: string;
            lock_timeout: string;
            read_only: string;
            isolation: string;
          }>`select current_setting('statement_timeout') as statement_timeout,
            current_setting('lock_timeout') as lock_timeout,
            current_setting('transaction_read_only') as read_only,
            current_setting('transaction_isolation') as isolation`;
          // A write in a transaction of its own still works on that connection.
          const written = yield* sql.withTransaction(
            sql`create temporary table written (x int) on commit drop`.pipe(Effect.as(true)),
          );
          return { ...settings, written };
        }),
      );
      assert.deepEqual(session, {
        statement_timeout: "0",
        lock_timeout: "0",
        read_only: "off",
        // Not the batch's repeatable-read snapshot: its transaction ended with it.
        isolation: "read committed",
        written: true,
      });
    } finally {
      await runtime.dispose();
    }
  });
});

test("a shape read that fails never blinds a healthy check and never refuses, on either pool", async () => {
  await withDatabase(
    async ({ schema, url }) => {
      for (const mode of modes) {
        const runtime = eventPool(url, schema, mode);
        try {
          // The rule alone decides a healthy check, so its own pool answers 204 and writes nothing.
          const healthy = await checkOn(runtime, mode);
          assert.deepEqual([healthy.status, healthy.lines], [204, []], mode);
          // A refusal needs the shape read to say why; without it the answer is unavailable.
          const unexplained = await checkOn(runtime, mode, "org_other", pool);
          assert.deepEqual(
            [unexplained.status, unexplained.lines],
            [503, ["Pool organization ownership not observed: read-failed"]],
            mode,
          );
        } finally {
          await runtime.dispose();
        }
      }
    },
    { jsonbMetadata: true },
  );
});
