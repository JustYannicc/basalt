// An app frame signs in to its app's origin by writing an app session as a Better Auth verification
// row. Here Better Auth stores the rows over PGlite, the hosted app-session service writes and
// checks them, the hosted migration code installs the change triggers and journal, and the app
// frame's own change stream reads the result. Stand-ins: the change transport (one queue per scope,
// fed by the journal's delivery), the pool's change heads, and the app-use check, which always grants.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { organization as organizations } from "better-auth/plugins/organization";
import { Effect, Fiber, Queue, Redacted, Schema, Stream, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import { makeAuthDatabase } from "@executor-js/mcp-auth/node-database";
import { pgliteLayer } from "fumadb-effect/pglite";
import type {
  RevisionEvent,
  RevisionHint,
} from "../.upstream/packages/app-data/src/contracts/change-revisions.ts";
import { AppReturnPath } from "../.upstream/packages/apps/src/contracts/ui-auth.ts";
import { AppUiTarget } from "../.upstream/apps/hosted/server/src/contracts/app-ui.ts";
import { Principal } from "../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { GroupDatabase } from "../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { organizationOwner } from "../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { PoolUsageBackend } from "../.upstream/apps/hosted/server/src/contracts/pool-usage.ts";
import {
  accountChangeTrigger,
  accountChangeTriggers,
  installAccountChangeFunction,
} from "../.upstream/apps/hosted/server/src/implementation/account-change-schema.ts";
import { hostedAppSessions } from "../.upstream/apps/hosted/server/src/implementation/app-sessions.ts";
import {
  activateChangeJournal,
  prepareChangeJournal,
} from "../.upstream/apps/hosted/server/src/implementation/change-journal-schema.ts";
import { migrateChangeRevisions } from "../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { makeChangeJournal } from "../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { migrateDeferredChanges } from "../.upstream/apps/hosted/server/src/implementation/deferred-change-schema.ts";
import {
  hostedProductMigrations,
  migrateProductSteps,
} from "../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import { makeAppChanges } from "../.upstream/apps/hosted/server/src/implementation/pool-app-changes.ts";
import { ScopedChanges } from "../.upstream/apps/hosted/server/src/implementation/scoped-changes.ts";

const hostedJournal = (
  JSON.parse(
    readFileSync(new URL("../scripts/upstream-tests/migration-journals.json", import.meta.url), "utf8"),
  ) as { private_hosted_migrations: string[] }
).private_hosted_migrations;
const target = Schema.decodeUnknownSync(AppUiTarget)({
  app: "app_frame",
  organization: "org_frame",
  slug: "frame-team",
  origin: "https://frame.example.test",
});
const home = Schema.decodeUnknownSync(AppReturnPath)("/");
const appSessionRows = "identifier like 'executor-app-ui:v1:session:%'";
const revoked = "event: revoked\ndata: {}\n\n";
// Each owner's first message acknowledges the subscription.
const registration: RevisionEvent = { kind: "current", revisions: [], snapshotRequired: true };

/** The app frame's change stream as its origin serves it, bound to one app session cookie. */
const openAppChanges = (
  sql: SqlClient.SqlClient,
  sessions: ReturnType<typeof hostedAppSessions>,
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const queues = new Map<string, Queue.Queue<RevisionEvent>>();
    const queue = (scope: string) =>
      Effect.gen(function* () {
        const existing = queues.get(scope);
        if (existing) return existing;
        const created = yield* Queue.unbounded<RevisionEvent>();
        queues.set(scope, created);
        return created;
      });
    const published: { scope: string; hint: RevisionHint }[] = [];
    const publish = (scope: string, hint: RevisionHint) =>
      queue(scope).pipe(
        Effect.tap(() => Effect.sync(() => published.push({ scope, hint }))),
        Effect.flatMap((owner) => Queue.offer(owner, { kind: "changed", hint })),
        Effect.asVoid,
      );
    const transport = ScopedChanges.of({
      subscribe: (scope) =>
        Stream.unwrap(
          Effect.map(queue(scope), (owner) =>
            Stream.make(registration).pipe(Stream.concat(Stream.fromQueue(owner))),
          ),
        ),
      publish,
    });
    const authorize = sessions.current(target, token).pipe(
      Effect.map((identity) => ({
        app: { id: target.app },
        access: {
          organization: target.organization,
          owner: organizationOwner(target.organization),
          role: "member" as const,
          userId: identity.userId,
        },
        changeSession: identity,
      })),
    );
    const response = yield* makeAppChanges(authorize).events.pipe(
      Effect.provideService(ScopedChanges, transport),
      Effect.provideService(GroupDatabase, Effect.succeed(sql)),
      Effect.provideService(PoolUsageBackend, {
        origin: "https://pool.example.test",
        // Hosts sign pool commands with a 256-bit hex key.
        key: Redacted.make("0".repeat(64)),
      }),
      // The pool's own heads never move here.
      Effect.provideService(FetchHttpClient.Fetch, async () => Response.json({ revisions: [] })),
    );
    assert.equal(response.status, 200);
    if (response.body._tag !== "Stream") throw new Error("the change stream has no body");
    const frames = yield* Queue.unbounded<string>();
    const done = yield* response.body.stream.pipe(
      Stream.decodeText,
      Stream.runForEach((frame) => Queue.offer(frames, frame)),
      Effect.forkScoped,
    );
    return { frames, done, published, publish };
  });
type AppStream = Effect.Success<ReturnType<typeof openAppChanges>>;

/**
 * Better Auth's tables, then the hosted change schema as hosted steps 19 to 22 leave it, with only
 * the session and verification triggers: the other triggers' tables do not exist here.
 */
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const options = {
    database: { db: yield* makeAuthDatabase, type: "postgres" as const, transaction: true },
    // As the hosted server's: its admin plugin adds the session column app sessions read.
    plugins: [admin(), organizations()],
    // As on app origins, which check expiry themselves.
    verification: { disableCleanup: true },
    secret: "fixture-only-app-session-secret-never-used-elsewhere",
    logger: { disabled: true },
  };
  yield* Effect.promise(async () => (await getMigrations(options)).runMigrations());
  const context = yield* Effect.promise(() => betterAuth(options).$context);
  // Change revisions install a trigger here, and every topic's skips read observations.
  yield* sql`create table executor_apps (id text primary key, owner text, active_deployment text)`;
  yield* sql`create table executor_account_observations (account text, source text)`;
  yield* migrateChangeRevisions;
  yield* migrateDeferredChanges;
  yield* prepareChangeJournal;
  yield* activateChangeJournal;
  yield* installAccountChangeFunction;
  for (const trigger of accountChangeTriggers)
    if (trigger[0] === "session" || trigger[0] === "verification")
      yield* sql.unsafe(accountChangeTrigger(trigger));
  const { user, login } = yield* Effect.promise(async () => {
    const user = await context.internalAdapter.createUser(
      { name: "Viewer", email: "viewer@example.invalid", emailVerified: true },
      { method: "admin" },
    );
    const login = await context.internalAdapter.createSession(user.id);
    await context.adapter.create({
      model: "organization",
      data: {
        id: target.organization,
        name: "Frame team",
        slug: target.slug,
        createdAt: new Date(),
      },
      forceAllowId: true,
    });
    await context.adapter.create({
      model: "member",
      data: {
        organizationId: target.organization,
        userId: user.id,
        role: "member",
        createdAt: new Date(),
      },
    });
    return { user, login };
  });
  const sessions = hostedAppSessions(context, globalThis.crypto);
  const principal = Principal.make({
    userId: Principal.fields.userId.make(user.id),
    sessionId: Principal.fields.sessionId.make(login.id),
    name: user.name,
  });
  // The app page begins the sign-in and the dashboard grants it; the callback completes it.
  const begin = Effect.gen(function* () {
    const { request, proof } = yield* sessions.begin(target, home);
    return { request, proof, code: yield* sessions.grant(request, target, principal) };
  });
  const complete = (attempt: Effect.Success<typeof begin>) =>
    sessions
      .complete(target, attempt.request, attempt.code, attempt.proof)
      .pipe(Effect.map(({ token }) => token));
  const journal = makeChangeJournal(sql);
  // Setup's own hints, such as the login's session row, go out before any stream opens.
  yield* journal.deliver(() => Effect.void);
  return {
    sql,
    user: user.id,
    logout: Effect.promise(() => context.internalAdapter.deleteSession(login.token)),
    newLogin: Effect.promise(() => context.internalAdapter.createSession(user.id)),
    begin,
    complete,
    signIn: Effect.flatMap(begin, complete),
    open: (token: Redacted.Redacted<string>) => openAppChanges(sql, sessions, token),
    deliver: (stream: AppStream) => journal.deliver(stream.publish),
  };
});

const fixture = <A, E>(
  work: (f: Effect.Success<typeof setup>) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(setup, work)).pipe(Effect.provide(pgliteLayer())));

/** What a write queued: hosted_queue_change's rows, which stay until the projector claims them. */
const queued = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`select hosted_project_changes(100)`;
    const value = yield* write;
    const changes = yield* sql<{ scope: string; topic: string }>`select scope, topic
      from hosted_change_dirty order by scope, topic`;
    return { value, changes: changes.map(({ scope, topic }) => ({ scope, topic })) };
  });

const next = (stream: AppStream) => Queue.take(stream.frames).pipe(Effect.timeout("10 seconds"));
const ended = (stream: AppStream) => Fiber.join(stream.done).pipe(Effect.timeout("10 seconds"));

test("an app frame's new session queues no session change for its person", () =>
  fixture(({ begin, complete }) =>
    Effect.gen(function* () {
      const attempt = yield* begin;
      const { changes } = yield* queued(complete(attempt));
      assert.deepEqual(changes, [], "the callback's sign-in changes no one's access");
    }),
  ));

test("changing or ending an app session, or starting or ending a login, still queues the person's session change", () =>
  fixture(({ sql, user, logout, newLogin, signIn }) =>
    Effect.gen(function* () {
      yield* signIn;
      const session = [{ scope: `user:${user}`, topic: "session" }];
      const write = (statement: string) =>
        queued(sql.unsafe(statement)).pipe(Effect.map((q) => q.changes));
      assert.deepEqual(
        yield* write(
          `update verification set "expiresAt" = "expiresAt" - interval '1 minute' where ${appSessionRows}`,
        ),
        session,
        "a shortened app session",
      );
      assert.deepEqual(
        yield* write(`update verification set value = value || ' ' where ${appSessionRows}`),
        session,
        "a rewritten app session",
      );
      assert.deepEqual(
        yield* write(
          `update verification set "updatedAt" = now() + interval '1 second' where ${appSessionRows}`,
        ),
        [],
        "bookkeeping alone",
      );
      assert.deepEqual(
        yield* write(`delete from verification where ${appSessionRows}`),
        session,
        "an ended app session",
      );
      // Only the app session's insert is quiet; a new login still publishes.
      assert.deepEqual((yield* queued(newLogin)).changes, session, "a new login");
      assert.deepEqual((yield* queued(logout)).changes, session, "an ended login");
    }),
  ));

test("an app frame's change stream still ends when its app session or its login ends", () =>
  fixture(({ sql, logout, signIn, open, deliver }) =>
    Effect.gen(function* () {
      const first = yield* open(yield* signIn);
      assert.match(yield* next(first), /^event: current\n/);
      yield* sql.unsafe(`delete from verification where ${appSessionRows}`);
      yield* deliver(first);
      assert.equal(yield* next(first), revoked);
      yield* ended(first);

      const second = yield* open(yield* signIn);
      assert.match(yield* next(second), /^event: current\n/);
      // Another frame signs in; nothing reaches this stream.
      yield* signIn;
      yield* deliver(second);
      assert.deepEqual(second.published, []);
      yield* logout;
      yield* deliver(second);
      assert.equal(yield* next(second), revoked);
      yield* ended(second);
    }),
  ));

test("hosted step 24 reinstalls the trigger body on a database that already ran step 20", () =>
  fixture(({ sql, user, signIn }) =>
    Effect.gen(function* () {
      const body = () =>
        sql<{ definition: string; oid: string; bound: string }>`select
          pg_get_functiondef(p.oid) as definition, p.oid::text as oid,
          (select count(*) from pg_trigger t where t.tgfoid = p.oid)::text as bound
          from pg_proc p where p.oid = 'hosted_account_changed()'::regprocedure`.pipe(
          Effect.map((rows) => rows[0]!),
        );
      const current = yield* body();
      // The body before step 24: the same function without the skip for new app sessions.
      const lines = current.definition.split("\n");
      const skip = lines.findIndex((line) =>
        line.includes("TG_TABLE_NAME = 'verification' and TG_OP = 'INSERT'"),
      );
      assert.ok(skip > 0 && lines[skip - 1]!.trim().startsWith("--"));
      yield* sql.unsafe(lines.toSpliced(skip - 1, 2).join("\n"));
      const old = yield* body();
      assert.deepEqual(
        (yield* queued(signIn)).changes,
        [{ scope: `user:${user}`, topic: "session" }],
        "the old body publishes a new app session",
      );
      yield* migrateProductSteps("private_hosted_migrations", {});
      // A production database's steps 1 to 23, under the names the hosted lineage check expects.
      for (const key of hostedJournal.filter((key) => Number(key.split("_", 1)[0]) <= 23)) {
        const [id, ...name] = key.split("_");
        yield* sql`insert into private_hosted_migrations (migration_id, name)
          values (${Number(id)}, ${name.join("_")})`;
      }
      yield* hostedProductMigrations;
      assert.deepEqual(
        yield* sql`select migration_id, name from private_hosted_migrations where migration_id > 23`,
        [{ migration_id: 24, name: "app_session_inserts" }],
      );
      const installed = yield* body();
      assert.equal(installed.definition, current.definition);
      assert.deepEqual(
        { oid: installed.oid, bound: installed.bound },
        { oid: old.oid, bound: "2" },
        "the session and verification triggers stay bound to the same function",
      );
      assert.deepEqual((yield* queued(signIn)).changes, [], "a new app session publishes nothing");
    }),
  ));
