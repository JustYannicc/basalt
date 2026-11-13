import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Clock, Effect, Layer, Queue, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient, Statement } from "effect/sql";
import { TestClock } from "effect/testing";
import { singleResourceOrigin } from "../../.upstream/packages/mcp-auth/src/index.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import {
  Authentication,
  AuthenticationUnavailable,
  Principal,
} from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import {
  OrganizationForbidden,
  OrganizationId,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { OrganizationTombstones } from "../../.upstream/apps/hosted/server/src/contracts/organization-removal.ts";
import {
  makeOrganizationChanges,
  organizationChangesPath,
  organizationChangesCurrentPath,
  organizationChangeKeys,
  sessionChangeKeys,
} from "../../.upstream/apps/hosted/server/src/implementation/organization-changes.ts";
import { ScopedChanges } from "../../.upstream/apps/hosted/server/src/implementation/scoped-changes.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { migrateAccountChanges } from "../../.upstream/apps/hosted/server/src/implementation/account-change-schema.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import type {
  ChangeKey,
  RevisionEvent,
} from "../../.upstream/packages/app-data/src/contracts/change-revisions.ts";

const origin = "https://changes.example.test";
const organization = OrganizationId.make("team-a");
const path = "/api/organizations/team-a/changes";
const accountKey = { topic: "accounts", resource: "*" };
const registration = { kind: "current", revisions: [], snapshotRequired: true } as const;

function frames(response: Response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    cancel: () => reader.cancel(),
    async next(): Promise<string | undefined> {
      while (!pending.includes("\n\n")) {
        const result = await reader.read();
        if (result.done) {
          assert.equal(pending, "", "the server closed between SSE frame boundaries");
          return undefined;
        }
        pending += decoder.decode(result.value, { stream: true });
      }
      const end = pending.indexOf("\n\n") + 2;
      const frame = pending.slice(0, end);
      pending = pending.slice(end);
      return frame;
    },
  };
}

const fixture = <A>(context: TestContext, work: (f: Fixture) => Promise<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      yield* TestClock.setTime(Date.now());
      context.mock.method(Date, "now", () => clock.currentTimeMillisUnsafe());
      const expiresAt = new Date(Date.now() + 60_000);
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* makeExecutorStorage({ provider: "postgresql" })).migrate;
      for (const ddl of [
        'create table "user" (id text primary key, name text, "updatedAt" timestamptz)',
        'create table session (id text primary key, "userId" text, "expiresAt" timestamptz, "updatedAt" timestamptz)',
        'create table verification (id text primary key, identifier text, value text, "updatedAt" timestamptz)',
        'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
        "create table organization (id text primary key, metadata text)",
        "create table hosted_app_account_links (app text, account text)",
        "create table hosted_app_access (id text, organization_id text, audience text)",
        "create table hosted_account_access (account_id text, organization_id text, audience text)",
        "create table hosted_account_observation_access (account_id text, organization_id text)",
        "create table hosted_account_rechecks (account_id text, organization_id text)",
        "create table hosted_app_groups (app_id text, organization_id text, group_id text)",
        "create table hosted_account_groups (account_id text, organization_id text, group_id text)",
        "create table hosted_model_bindings (app_id text, pool_id text)",
        "create table hosted_groups (id text, organization_id text)",
        "create table hosted_group_members (group_id text, member_id text)",
        "create table hosted_provisioning (organization_id text, status text)",
        "create table hosted_organization_removal (organization_id text, status text)",
      ])
        yield* sql.unsafe(ddl);
      yield* sql`insert into executor_providers (id,definition) values ('prv_a','{}')`;
      yield* sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at)
        values ('acc_a','organization:team-a','prv_a','key','Retained',${new Uint8Array([1])},now())`;
      yield* sql`insert into organization values ('team-a','{}')`;
      yield* sql`insert into "user" values ('viewer-a','Viewer',now())`;
      yield* sql`insert into member values ('member-a','team-a','viewer-a','member')`;
      yield* sql`insert into session values ('session-a','viewer-a',${expiresAt},now())`;
      yield* migrateChangeRevisions;
      yield* migrateAccountChanges;
      const state = {
        queries: [] as string[],
        subscriptions: [] as { scope: string; keys: readonly ChangeKey[] }[],
        authority: { session: 0, membership: 0 },
        beforeHead: undefined as Effect.Effect<void, unknown> | undefined,
        register: (_scope: string): Effect.Effect<void, unknown> => Effect.void,
      };
      const transformer: Statement.Transformer = (statement) =>
        Effect.gen(function* () {
          const query = statement.compile()[0];
          state.queries.push(query);
          if (query.includes("from hosted_change_heads")) {
            assert.equal(
              state.subscriptions.length === 0 || state.subscriptions.length === 2,
              true,
            );
            const before = state.beforeHead;
            state.beforeHead = undefined;
            if (before) yield* before.pipe(Effect.orDie);
          }
          return statement;
        });
      const auth = Authentication.of({
        origin,
        resourceOrigins: singleResourceOrigin(origin),
        current: (headers) =>
          Effect.gen(function* () {
            state.authority.session++;
            const session =
              headers.get("cookie")?.match(/fixture-session=([^;]+)/u)?.[1] ?? "session-a";
            const rows = yield* sql<{
              userId: string;
              expiresAt: Date;
            }>`select "userId", "expiresAt"
            from session where id = ${session}`;
            const row = rows[0];
            return !row || row.expiresAt.getTime() <= Date.now()
              ? null
              : Principal.make({
                  userId: Principal.fields.userId.make(row.userId),
                  sessionId: Principal.fields.sessionId.make(session),
                  name: "Viewer",
                });
          }).pipe(Effect.mapError(() => new AuthenticationUnavailable())),
        membership: (principal, target) =>
          Effect.gen(function* () {
            state.authority.membership++;
            const rows = yield* sql`select role from member
            where "organizationId" = ${target} and "userId" = ${principal.userId}`.pipe(
              Effect.mapError(() => new AuthenticationUnavailable()),
            );
            if (!rows.length) return yield* new OrganizationForbidden();
            return { role: "member" as const };
          }),
        organization: (reference) =>
          reference === "team-a" || reference === "team-a-slug"
            ? Effect.succeed(organization)
            : Effect.fail(new OrganizationForbidden()),
        organizationSlug: () => Effect.succeed("team-a-slug"),
        removeOrganization: () => Effect.die("unused fixture operation"),
      });
      const queues = new Map<string, Queue.Queue<RevisionEvent>>();
      for (const scope of ["organization:team-a", "user:viewer-a"])
        queues.set(scope, yield* Queue.make<RevisionEvent>());
      const transport = ScopedChanges.of({
        subscribe: (scope, keys) =>
          Stream.unwrap(
            Effect.gen(function* () {
              state.subscriptions.push({ scope, keys });
              yield* state.register(scope).pipe(Effect.orDie);
              const queue = queues.get(scope);
              assert.ok(queue, `unapproved subscription scope ${scope}`);
              return Stream.make(registration).pipe(Stream.concat(Stream.fromQueue(queue)));
            }),
          ),
        publish: (scope, hint) => {
          const queue = queues.get(scope);
          assert.ok(queue, `unapproved publication scope ${scope}`);
          return Queue.offer(queue, { kind: "changed", hint }).pipe(Effect.asVoid);
        },
      });
      const handlers = makeOrganizationChanges();
      const routes = Layer.mergeAll(
        HttpRouter.add("GET", organizationChangesPath, handlers.events),
        HttpRouter.add("GET", organizationChangesCurrentPath, handlers.current),
      ).pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(
            Layer.succeed(Authentication, auth),
            Layer.succeed(GroupDatabase, Effect.succeed(sql)),
            Layer.succeed(OrganizationTombstones, () => Effect.succeed(false)),
            Layer.succeed(ScopedChanges, transport),
          ),
        ),
        Layer.provide(HttpServer.layerServices),
      );
      return yield* Effect.tryPromise(async () => {
        const server = HttpRouter.toWebHandler(routes, {
          disableLogger: true,
          middleware: (effect) =>
            effect.pipe(
              Effect.provideService(Clock.Clock, clock),
              Effect.provideService(Statement.CurrentTransformer, transformer),
            ),
        });
        try {
          return await work({
            sql,
            state,
            expiresAt,
            request: (url = path, headers = {}) =>
              server.handler(new Request(`${origin}${url}`, { headers })),
            deliver: () => Effect.runPromise(makeChangeJournal(sql).deliver(transport.publish)),
            advance: (milliseconds) =>
              Effect.runPromise(
                TestClock.adjust(milliseconds).pipe(Effect.provideService(Clock.Clock, clock)),
              ),
          });
        } finally {
          await server.dispose();
        }
      });
    }).pipe(Effect.provide(pgliteLayer()), Effect.provide(TestClock.layer())),
  );

interface Fixture {
  sql: SqlClient.SqlClient;
  state: {
    queries: string[];
    subscriptions: { scope: string; keys: readonly ChangeKey[] }[];
    authority: { session: number; membership: number };
    beforeHead: Effect.Effect<void, unknown> | undefined;
    register: (scope: string) => Effect.Effect<void, unknown>;
  };
  expiresAt: Date;
  request: (url?: string, headers?: Record<string, string>) => Promise<Response>;
  deliver: () => Promise<void>;
  advance: (milliseconds: number) => Promise<void>;
}

test("organization SSE registers both scopes before reading committed heads, then delivers a real account write", (context) =>
  fixture(context, async (f) => {
    f.state.register = (scope) =>
      scope === "user:viewer-a"
        ? f.sql`update executor_accounts set label='During registration' where id='acc_a'`.pipe(
            Effect.asVoid,
          )
        : Effect.void;
    const stream = frames(await f.request());
    try {
      const first = await stream.next();
      assert.ok(first !== undefined, "the stream must acknowledge registration");
      assert.ok(first?.startsWith("event: current\n"));
      assert.match(first, /"topic":"accounts","resource":"\*","revision":"1"/);
      assert.equal(f.state.subscriptions.length, 2);
      assert.ok(f.state.queries.some((query) => query.includes("from hosted_change_heads")));
      await Effect.runPromise(
        f.sql`update executor_accounts set label='After registration' where id='acc_a'`,
      );
      await f.deliver();
      assert.equal(
        await stream.next(),
        `event: changed\ndata: ${JSON.stringify({
          kind: "changed",
          hint: { ...accountKey, revision: "2" },
        })}\n\n`,
      );
      assert.deepEqual(await Effect.runPromise(f.sql`select * from hosted_change_pending`), []);
    } finally {
      await stream.cancel();
    }
  }));

test("current returns identity and live expiry, ignores query scopes and refuses bearer identity", (context) =>
  fixture(context, async (f) => {
    const url = `${path}/current?scope=organization:team-b&user=other&topics=credentials&keys=private`;
    const first = await f.request(url);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "private, no-store");
    const body = await first.json();
    assert.equal(body.validUntil, f.expiresAt.getTime());
    assert.match(body.identity, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      body.revisions,
      [...organizationChangeKeys, ...sessionChangeKeys].map((key) => ({ ...key, revision: "0" })),
    );
    const nextExpiry = new Date(f.expiresAt.getTime() + 5_000);
    await Effect.runPromise(
      f.sql`update session set "expiresAt"=${nextExpiry} where id='session-a'`,
    );
    const next = await (await f.request(`${path}/current`)).json();
    assert.equal(next.validUntil, nextExpiry.getTime());
    assert.equal(next.identity, body.identity);
    await Effect.runPromise(
      f.sql`insert into session values ('session-b','viewer-a',${nextExpiry},now())`,
    );
    const rotated = await (
      await f.request(`${path}/current`, { cookie: "fixture-session=session-b" })
    ).json();
    assert.notEqual(
      rotated.identity,
      body.identity,
      "a replacement session must invalidate browser cache identity",
    );
    for (const suffix of ["", "/current"])
      assert.equal(
        (await f.request(`${path}${suffix}`, { authorization: "Bearer fixture-denied" })).status,
        401,
      );
    assert.equal(f.state.subscriptions.length, 0);
    const stream = frames(await f.request(`${path}?scope=user:other&topics=credentials`));
    try {
      await stream.next();
      assert.deepEqual(
        f.state.subscriptions.sort((a, b) => a.scope.localeCompare(b.scope)),
        [
          { scope: "organization:team-a", keys: organizationChangeKeys },
          { scope: "user:viewer-a", keys: sessionChangeKeys },
        ],
      );
    } finally {
      await stream.cancel();
    }
  }));

for (const revoked of ["session", "membership"] as const) {
  const revoke = (f: Fixture) =>
    revoked === "session"
      ? f.sql`delete from session where id='session-a'`
      : f.sql`delete from member where id='member-a'`;
  test(`current rechecks live ${revoked} after reading the SQL heads`, (context) =>
    fixture(context, async (f) => {
      assert.equal((await f.request(`${path}/current`)).status, 200);
      const before = { ...f.state.authority };
      f.state.beforeHead = revoke(f).pipe(Effect.asVoid);
      assert.equal((await f.request(`${path}/current`)).status, revoked === "session" ? 401 : 403);
      assert.ok(f.state.authority.session >= before.session + 2);
      if (revoked === "membership")
        assert.ok(f.state.authority.membership >= before.membership + 2);
      assert.equal((await f.request(`${path}/current`)).status, revoked === "session" ? 401 : 403);
    }));
  test(`an open organization stream closes with revoked and no private hint after ${revoked} deletion`, (context) =>
    fixture(context, async (f) => {
      const stream = frames(await f.request());
      try {
        assert.ok((await stream.next())?.startsWith("event: current\n"));
        await Effect.runPromise(revoke(f));
        await Effect.runPromise(
          f.sql`update executor_accounts set label='Private after revocation' where id='acc_a'`,
        );
        await f.deliver();
        assert.equal(await stream.next(), "event: revoked\ndata: {}\n\n");
        assert.equal(await stream.next(), undefined);
      } finally {
        await stream.cancel();
      }
    }));
}

test("idle organization heartbeats perform zero SQL and absolute session expiry revokes and closes", (context) =>
  fixture(context, async (f) => {
    const stream = frames(await f.request());
    try {
      assert.ok((await stream.next())?.startsWith("event: current\n"));
      const before = { queries: f.state.queries.length, ...f.state.authority };
      const heartbeat = stream.next();
      await f.advance(30_000);
      assert.equal(await heartbeat, ": heartbeat\n\n");
      assert.equal(f.state.queries.length, before.queries);
      assert.deepEqual(f.state.authority, {
        session: before.session,
        membership: before.membership,
      });
      await f.advance(30_000);
      const remaining: string[] = [];
      for (let frame = await stream.next(); frame !== undefined; frame = await stream.next())
        remaining.push(frame);
      assert.equal(remaining.at(-1), "event: revoked\ndata: {}\n\n");
      assert.ok(remaining.slice(0, -1).every((frame) => frame === ": heartbeat\n\n"));
      assert.equal(f.state.queries.length, before.queries, "expiry must not poll SQL either");
    } finally {
      await stream.cancel();
    }
  }));
