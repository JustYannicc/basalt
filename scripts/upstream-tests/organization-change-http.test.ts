import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Clock, Effect, Layer, Queue, Schema, Stream } from "effect";
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
import {
  ScopedChanges,
  ChangeSnapshot,
} from "../../.upstream/apps/hosted/server/src/implementation/scoped-changes.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { migrateAccountChanges } from "../../.upstream/apps/hosted/server/src/implementation/account-change-schema.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { migrateAccountTrafficChanges } from "../../.upstream/apps/hosted/server/src/implementation/account-traffic-change-schema.ts";
import { makeAccountTrafficStore } from "../../.upstream/packages/sdk/src/implementation/account-traffic-store.ts";
import { AccountId } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
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
        "create table hosted_app_access (id text, organization_id text, audience text, creator_id text, revision text)",
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
        expectedSubscriptions: 2,
        queries: [] as string[],
        subscriptions: [] as { scope: string; keys: readonly ChangeKey[] }[],
        authority: { session: 0, membership: 0 },
        alias: organization,
        beforeHead: undefined as Effect.Effect<void, unknown> | undefined,
        register: (_scope: string): Effect.Effect<void, unknown> => Effect.void,
      };
      const transformer: Statement.Transformer = (statement) =>
        Effect.gen(function* () {
          const query = statement.compile()[0];
          state.queries.push(query);
          if (query.includes("from hosted_change_heads")) {
            assert.equal(
              state.subscriptions.length === 0 ||
                state.subscriptions.length === state.expectedSubscriptions,
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
          reference === "team-a"
            ? Effect.succeed(organization)
            : reference === "team-a-slug"
              ? Effect.succeed(state.alias)
              : Effect.fail(new OrganizationForbidden()),
        organizationSlug: () => Effect.succeed("team-a-slug"),
        removeOrganization: () => Effect.die("unused fixture operation"),
      });
      const queues = new Map<string, Queue.Queue<RevisionEvent>>();
      for (const scope of [
        "organization:team-a",
        "organization:team-b",
        "user:viewer-a",
        "user:viewer-b",
        "pool:app_a",
      ])
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
    expectedSubscriptions: number;
    queries: string[];
    subscriptions: { scope: string; keys: readonly ChangeKey[] }[];
    authority: { session: number; membership: number };
    alias: OrganizationId;
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
      assert.ok(
        f.state.queries.length > before.queries,
        "the absolute deadline rechecks authority once",
      );
    } finally {
      await stream.cancel();
    }
  }));

test("a renewed session resyncs at its old deadline instead of falsely revoking access", (context) =>
  fixture(context, async (f) => {
    const stream = frames(await f.request());
    try {
      assert.ok((await stream.next())?.startsWith("event: current\n"));
      await Effect.runPromise(
        f.sql`update session set "expiresAt"=${new Date(f.expiresAt.getTime() + 60_000)} where id='session-a'`,
      );
      await f.advance(60_000);
      const remaining: string[] = [];
      for (let frame = await stream.next(); frame !== undefined; frame = await stream.next())
        remaining.push(frame);
      assert.equal(remaining.at(-1), "event: resync\ndata: {}\n\n");
      assert.ok(!remaining.some((frame) => frame.startsWith("event: revoked")));
    } finally {
      await stream.cancel();
    }
  }));

test("a moved organization slug cannot authorize hints from the former scope", (context) =>
  fixture(context, async (f) => {
    const stream = frames(await f.request("/api/organizations/team-a-slug/changes"));
    try {
      assert.ok((await stream.next())?.startsWith("event: current\n"));
      await Effect.runPromise(
        f.sql`insert into member values ('member-b','team-b','viewer-a','member')`,
      );
      f.state.alias = OrganizationId.make("team-b");
      await Effect.runPromise(f.sql`delete from member where id='member-a'`);
      await Effect.runPromise(
        f.sql`update executor_accounts set label='Former private scope' where id='acc_a'`,
      );
      await f.deliver();
      assert.equal(await stream.next(), "event: revoked\ndata: {}\n\n");
      assert.equal(await stream.next(), undefined);
    } finally {
      await stream.cancel();
    }
  }));

test("selected pool heads are authorized, delivered and revoked with app access", (context) =>
  fixture(context, async (f) => {
    await Effect.runPromise(f.sql`insert into hosted_app_access (id,organization_id,audience,creator_id,revision)
      values ('app_a','team-a','everyone','other','00000000-0000-4000-8000-000000000001')`);
    const current = await f.request(`${path}/current?pool=app_a`);
    assert.equal(current.status, 200);
    const body = Schema.decodeUnknownSync(ChangeSnapshot)(await current.json());
    assert.ok(
      body.revisions.some((hint) => hint.topic === "pool-usage" && hint.resource === "app_a"),
    );
    const ordinary = Schema.decodeUnknownSync(ChangeSnapshot)(
      await (await f.request(`${path}/current`)).json(),
    );
    assert.equal(
      ordinary.revisions.some((hint) => hint.resource === "app_a"),
      false,
    );
    f.state.expectedSubscriptions = 3;
    const stream = frames(await f.request(`${path}?pool=app_a`));
    try {
      assert.match((await stream.next()) ?? "", /event: current/);
      await Effect.runPromise(
        f.sql`select hosted_queue_change('pool:app_a','pool-usage','app_a',8)`,
      );
      await f.deliver();
      assert.match(
        (await stream.next()) ?? "",
        /"topic":"pool-usage","resource":"app_a","revision":"8"/,
      );
      await Effect.runPromise(
        f.sql`update hosted_app_access set audience='private' where id='app_a'`,
      );
      await Effect.runPromise(
        f.sql`select hosted_queue_change('pool:app_a','pool-usage','app_a',9)`,
      );
      await f.deliver();
      assert.equal(
        await stream.next(),
        "event: revoked\ndata: {}\n\n",
        "no private revision is delivered after revocation",
      );
      assert.equal(await stream.next(), undefined, "revocation ends the existing stream");
      for (const url of [`${path}/current?pool=app_a`, `${path}?pool=app_a`]) {
        const refused = await f.request(url);
        assert.equal(refused.status, 403, "revoked members cannot open either pool-head path");
        assert.equal(await refused.text(), "", "a refusal contains no pool heads");
      }
    } finally {
      await stream.cancel();
    }
  }));

test("never-granted members receive no selected pool heads on the read or stream path", (context) =>
  fixture(context, async (f) => {
    await Effect.runPromise(f.sql`insert into hosted_app_access (id,organization_id,audience,creator_id,revision)
      values ('app_a','team-a','private','other','00000000-0000-4000-8000-000000000001')`);
    await Effect.runPromise(f.sql`select hosted_queue_change('pool:app_a','pool-usage','app_a',7)`);
    for (const url of [`${path}/current?pool=app_a`, `${path}?pool=app_a`]) {
      const refused = await f.request(url);
      assert.equal(refused.status, 403);
      assert.equal(await refused.text(), "", "denied members receive no pool revisions");
    }
    assert.deepEqual(f.state.subscriptions, [], "denied streams never subscribe to a pool");
  }));

test("private traffic keys are authorized before current heads and stream delivery, including guessed IDs", (context) =>
  fixture(context, async (f) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* f.sql`alter table hosted_account_access add column creator_id text,
        add column kind text, add column personal_user_id text, add column revision text`;
        yield* f.sql`insert into "user" values ('viewer-b','Other member',now())`;
        yield* f.sql`insert into member values ('member-b','team-a','viewer-b','member')`;
        yield* f.sql`insert into session values ('session-b','viewer-b',${f.expiresAt},now())`;
        yield* f.sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at)
        values ('acc_b','organization:team-a','prv_a','key','Private B',${new Uint8Array([2])},now())`;
        for (const [account, user] of [
          ["acc_a", "viewer-a"],
          ["acc_b", "viewer-b"],
        ])
          yield* f.sql`insert into hosted_account_access
          (account_id,organization_id,audience,creator_id,kind,personal_user_id,revision)
          values (${account},'team-a',null,${user},'personal',${user},'1')`;
        yield* migrateAccountTrafficChanges;
      }).pipe(Effect.provideService(SqlClient.SqlClient, f.sql)),
    );
    await f.deliver();
    const aPath = `${path}/current?account=acc_a`;
    const before = await (await f.request(aPath)).json();
    const stream = frames(await f.request(`${path}?account=acc_a`));
    try {
      assert.match((await stream.next()) ?? "", /event: current/);
      await Effect.runPromise(
        makeAccountTrafficStore(f.sql).record({
          accounts: [AccountId.make("acc_b")],
          at: Date.now(),
          ok: true,
        }),
      );
      await f.deliver();
      assert.deepEqual(
        (await (await f.request(aPath)).json()).revisions,
        before.revisions,
        "B's private activity exposes no new key or head to A",
      );
      const b = await (
        await f.request(`${path}/current?account=acc_b`, {
          cookie: "fixture-session=session-b",
        })
      ).json();
      assert.deepEqual(
        b.revisions.filter(({ topic }: { topic: string }) => topic === "account-traffic"),
        [{ topic: "account-traffic", resource: "acc_b", revision: "1" }],
      );
      for (const suffix of ["", "/current"])
        for (const account of ["acc_b", "acc_nonexistent"]) {
          const denied = await f.request(`${path}${suffix}?account=${account}`);
          assert.equal(denied.status, 403);
          assert.equal(
            await denied.text(),
            "",
            "a guessed private ID is indistinguishable from a missing account",
          );
        }
      await Effect.runPromise(
        makeAccountTrafficStore(f.sql).record({
          accounts: [AccountId.make("acc_a")],
          at: Date.now(),
          ok: true,
        }),
      );
      await f.deliver();
      assert.match(
        (await stream.next()) ?? "",
        /"topic":"account-traffic","resource":"acc_a","revision":"1"/,
        "the next delivered event is A's own call, with no private B event before it",
      );
      f.state.beforeHead = f.sql`update hosted_account_access set personal_user_id='viewer-b'
        where account_id='acc_a'`.pipe(Effect.asVoid);
      assert.equal(
        (await f.request(aPath)).status,
        403,
        "authority is checked again after reading selected account heads",
      );
    } finally {
      await stream.cancel();
    }
  }));

test("selected traffic accounts share the 32-key protocol budget with common and pool keys", (context) =>
  fixture(context, async (f) => {
    const accounts = ["acc_a", ...Array.from({ length: 26 }, (_, i) => `acc_limit_${i}`)];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* f.sql`alter table hosted_account_access add column creator_id text,
        add column kind text, add column personal_user_id text, add column revision text`;
        for (const account of accounts) {
          if (account !== "acc_a")
            yield* f.sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at)
            values (${account},'organization:team-a','prv_a','key','Visible',${new Uint8Array([2])},now())`;
          yield* f.sql`insert into hosted_account_access
          (account_id,organization_id,audience,creator_id,kind,personal_user_id,revision)
          values (${account},'team-a','everyone','viewer-a','shared',null,'1')`;
        }
        yield* f.sql`insert into hosted_app_access (id,organization_id,audience,creator_id,revision)
        values ('app_a','team-a','everyone','viewer-a','00000000-0000-4000-8000-000000000001')`;
      }),
    );
    const selected = (ids: readonly string[], pool = false) =>
      new URLSearchParams([
        ...ids.map((id) => ["account", id]),
        ...(pool ? [["pool", "app_a"]] : []),
      ]).toString();
    for (const [ids, pool] of [
      [accounts, false],
      [accounts.slice(0, 23), true],
    ] as const) {
      const response = await f.request(`${path}/current?${selected(ids, pool)}`);
      assert.equal(response.status, 200);
      const receipt = Schema.decodeUnknownSync(ChangeSnapshot)(await response.json());
      assert.equal(receipt.revisions.length, 32);
      assert.equal(
        receipt.revisions.filter(({ topic }) => topic === "account-traffic").length,
        ids.length,
      );
    }
    for (const [ids, pool] of [
      [accounts.concat("acc_too_many"), false],
      [accounts.slice(0, 24), true],
    ] as const)
      for (const suffix of ["", "/current"]) {
        const refused = await f.request(`${path}${suffix}?${selected(ids, pool)}`);
        assert.equal(refused.status, 400);
        assert.equal(await refused.text(), "", "oversized selectors expose no heads");
      }
    const duplicate = await f.request(`${path}/current?${selected(accounts.concat("acc_a"))}`);
    assert.equal(duplicate.status, 200, "the budget counts distinct account keys");
    assert.equal((await duplicate.json()).revisions.length, 32);
  }));
