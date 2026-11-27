import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { test } from "node:test";
import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Effect, Logger, ManagedRuntime, Redacted } from "effect";
import { HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import pg from "pg";
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
const application = `observation-${randomUUID().slice(0, 8)}`;

/**
 * A loopback proxy to the test database that never forwards a cancel request, as a Worker's socket
 * that closed with the response never sends one: only the database itself can end a cut read.
 */
async function withoutCancels(target: URL) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("data", (first: Buffer) => {
      // A cancel request is 16 bytes: its length, then the code 80877102.
      if (first.length >= 8 && first.readUInt32BE(0) === 16 && first.readUInt32BE(4) === 80877102)
        return;
      const upstream = net.connect(Number(target.port || 5432), target.hostname, () => {
        upstream.write(first);
        client.pipe(upstream);
        upstream.pipe(client);
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

/** One check, on its own small pool as one Worker event has, closed after the answer. */
async function check(url: string, schema: string) {
  const runtime = ManagedRuntime.make(
    PgClient.layer({
      url: Redacted.make(url),
      maxConnections: 2,
      applicationName: application,
      startupParameters: { search_path: schema },
    }),
  );
  const now = Date.now();
  const envelope = await signEnvelope(signingKey, "sbq1", {
    pool,
    organization: person,
    at: now,
    expiresAt: now + 30_000,
  });
  const started = performance.now();
  const response = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* SqlClient.SqlClient;
      return yield* readPoolOrganization.pipe(
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
        Effect.provide(Logger.layer([])),
      );
    }),
  );
  const ms = performance.now() - started;
  // The event's cleanup closes its pool after the response, as the Worker's does.
  await runtime.dispose();
  return { status: response.status, ms };
}

/** Backends of this test's pool still running a statement, or still waiting on a lock. */
async function busy(admin: pg.Client) {
  const { rows } = await admin.query(
    "select count(*)::int as n from pg_stat_activity where application_name = $1 and state = 'active'",
    [application],
  );
  return rows[0].n as number;
}

test("an observation read stuck behind a lock ends in the database, so it keeps no connection", async () => {
  const adminUrl = postgresUrl();
  const schema = `observation_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  const locker = new pg.Client({ connectionString: adminUrl });
  await Promise.all([admin.connect(), locker.connect()]);
  const proxy = await withoutCancels(new URL(adminUrl));
  const ask = () => check(proxy.url, schema);
  try {
    await admin.query(`create schema ${schema}`);
    await admin.query(`set search_path = ${schema}`);
    await admin.query("create table organization (id text primary key, metadata text)");
    await admin.query(
      "create table executor_apps (id text primary key, owner text not null, active_deployment text)",
    );
    await admin.query("insert into organization values ($1, $2)", [
      person,
      JSON.stringify({ basaltPools: { [pool]: { app: pool, membership: "executor-links-v1" } } }),
    ]);
    await admin.query("insert into executor_apps values ($1, $2, $3)", [
      pool,
      `organization:${person}`,
      `dpl_${pool}`,
    ]);
    assert.deepEqual(await ask().then((answer) => answer.status), 204);

    // A migration holds the apps table: every ownership read now waits on its lock.
    await locker.query("begin");
    await locker.query(`lock table ${schema}.executor_apps in access exclusive mode`);
    const answers = await Promise.all(Array.from({ length: 24 }, () => ask()));
    assert.ok(
      answers.every((answer) => answer.status === 204),
      answers.map((answer) => answer.status).join(","),
    );
    // Each answer waited at most the observation's 300 ms bound beyond the existing read.
    assert.ok(Math.max(...answers.map((answer) => answer.ms)) < 1_500);
    // The database ends each stuck read after 250 ms, though no cancel reaches it.
    const deadline = performance.now() + 1_500;
    while ((await busy(admin)) > 0 && performance.now() < deadline);
    assert.equal(await busy(admin), 0, "a cut observation read still holds its connection");
    // The next request gets a connection without waiting on the cut ones.
    const next = await ask();
    assert.equal(next.status, 204);
    assert.ok(next.ms < 1_000, String(next.ms));
  } finally {
    // The lock goes first, so a failed run can still clean up after itself.
    await locker.query("rollback").catch(() => {});
    await proxy.close();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await Promise.all([admin.end(), locker.end()]);
  }
});
