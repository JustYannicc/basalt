import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before } from "node:test";
import { PgClient } from "@effect/sql-pg";
import { Deferred, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { FetchHttpClient } from "effect/http";
import { AppId, OwnerId } from "../../.upstream/packages/sdk/src/core.ts";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import {
  CurrentOrganization,
  OrganizationId,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { PoolUsageBackend } from "../../.upstream/apps/hosted/server/src/contracts/pool-usage.ts";

let container: string | undefined;
let port: number;
before(
  async () => {
    container = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--detach",
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "postgres:17",
      ],
      { encoding: "utf8" },
    ).trim();
    const logs = spawn("docker", ["logs", "--follow", container]);
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const ready = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-16_384);
          if (/\[1\] LOG:  database system is ready to accept connections/.test(output)) resolve();
        };
        logs.stdout.on("data", ready);
        logs.stderr.on("data", ready);
        logs.on("error", reject);
        logs.on("exit", (code) => reject(new Error(`Postgres log follower exited ${code}`)));
      });
    } finally {
      logs.kill();
    }
    const binding = execFileSync("docker", ["port", container, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    port = Number(binding.split(":")[1]);
  },
  { timeout: 30_000 },
);
after(() => {
  if (container)
    execFileSync("docker", ["rm", "--force", "--volumes", container], { stdio: "ignore" });
});

export const app = AppId.make("app_shared_authority");
export const organization = OrganizationId.make("org_shared_authority");
export const owner = "owner";
export const caller = "reader";
const key = "ab".repeat(32);
const zero = {
  requests: 0,
  cost: 0,
  unpriced: 0,
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
};
const usage = {
  from: "2026-01-01",
  to: "2026-01-02",
  readAt: null,
  members: [caller, owner].map((member) => ({ ...zero, member, models: [], days: [], cap: null })),
};
const imported = {
  mode: "apply",
  format: "cpamp-v1-jsonl",
  totalDetails: 0,
  pageDetails: 0,
  aggregateOnlyNotImportable: "none",
  indistinguishableDetails: 0,
  unpriced: 0,
  missingProvider: 0,
  missingEndpoint: 0,
  missingLatency: 0,
  missingPriceSnapshot: 0,
  existing: 0,
  wouldInsert: 0,
  inserted: 0,
  ids: [],
  next: null,
  approval: null,
};

export const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

/** Observe a database or receiver milestone; elapsed time is only a failing safety bound. */
export const until = <A, E, R>(read: Effect.Effect<A, E, R>, ready: (value: A) => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    while (true) {
      const result = yield* read;
      if (ready(result)) return result;
      assert.ok(Date.now() < deadline, "database milestone did not arrive");
    }
  });

export const postgresFixture = <A, E>(
  run: (context: {
    sql: SqlClient.SqlClient;
    requests: string[];
    hold: ReturnType<typeof barrier>;
    arrived: Deferred.Deferred<void>;
    waiting: Effect.Effect<readonly { mode: string }[], unknown>;
    locks: Effect.Effect<readonly { mode: string; granted: boolean }[], unknown>;
    fail: () => void;
  }) => Effect.Effect<A, E, SqlClient.SqlClient | GroupDatabase | CurrentOrganization>,
) => {
  const schema = `org_lock_${randomUUID().replaceAll("-", "")}`;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const requests: string[] = [];
        const hold = barrier();
        const arrived = yield* Deferred.make<void>();
        let failure = false;
        yield* sql.unsafe(`create schema ${schema}`);
        for (const statement of [
          'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
          'create table "user" (id text primary key, name text, email text)',
          "create table organization (id text primary key, metadata text)",
          "create table executor_apps (id text primary key, owner text)",
          "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
          "create table hosted_app_groups (app_id text, group_id text)",
          "create table hosted_group_members (group_id text, member_id text)",
          "create table hosted_model_bindings (app_id text, authorizer text, pool_id text, subject text)",
        ])
          yield* sql.unsafe(statement);
        yield* sql`insert into member values ('m-owner', ${organization}, ${owner}, 'owner'), ('m-reader', ${organization}, ${caller}, 'admin')`;
        yield* sql`insert into "user" values (${owner}, 'Owner', 'owner@example.invalid'), (${caller}, 'Reader', 'reader@example.invalid')`;
        yield* sql`insert into organization values (${organization}, ${JSON.stringify({ basaltPools: { [owner]: { app, owner, authorization: "executor-app-v1" } } })})`;
        yield* sql`insert into executor_apps values (${app}, ${`organization:${organization}`})`;
        yield* sql`insert into hosted_app_access values (${app}, ${organization}, ${owner}, 'everyone', 'revision-one')`;
        const locks = sql<{
          mode: string;
          granted: boolean;
        }>`select l.mode, l.granted from pg_locks l
    join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and a.application_name = current_setting('application_name')`;
        const waiting = locks.pipe(Effect.map((rows) => rows.filter((row) => !row.granted)));
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          requests.push(new URL(request.url).pathname);
          Deferred.doneUnsafe(arrived, Effect.void);
          await hold.promise;
          if (failure) throw new Error("synthetic receiver failure");
          return Response.json(
            request.url.endsWith("managed-usage")
              ? usage
              : request.url.endsWith("/import/owner")
                ? imported
                : { success: true },
          );
        };
        return yield* run({
          sql,
          requests,
          hold,
          arrived,
          waiting,
          locks,
          fail: () => {
            failure = true;
          },
        }).pipe(
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(CurrentUserId, caller),
          Effect.provideService(CurrentOrganization, {
            organization,
            owner: OwnerId.make(`organization:${organization}`),
            role: "admin",
          }),
          Effect.provideService(PoolUsageBackend, {
            origin: "https://pool.example.invalid",
            key: Redacted.make(key),
          }),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.ensuring(Effect.sync(hold.release)),
        );
      }).pipe(
        Effect.provide(
          PgClient.layer({
            host: "127.0.0.1",
            port,
            username: "postgres",
            database: "postgres",
            ssl: false,
            maxConnections: 8,
            applicationName: `org-lock-${randomUUID()}`,
            startupParameters: {
              search_path: schema,
              lock_timeout: "10000",
              statement_timeout: "15000",
            },
          }),
        ),
      ),
    ),
  );
};
