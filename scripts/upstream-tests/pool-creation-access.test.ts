import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { ConfigProvider, Effect, Exit, Option, Redacted, Schema, type Crypto } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  AccountId,
  AccountNotFound,
  AppId,
  AppNameTaken,
  AppNotFound,
  SourceFiles,
  StorageHost,
  VersionId,
  type Account,
  type App,
  type Executor,
} from "../../.upstream/packages/sdk/src/core.ts";
import { AccessLifecycle } from "../../.upstream/apps/hosted/server/src/contracts/access-lifecycle.ts";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { HostedExecutor } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import {
  CurrentOrganization,
  OrganizationId,
  organizationOwner,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { OrganizationDefaults } from "../../.upstream/apps/hosted/server/src/contracts/organization-defaults.ts";
import { PoolAppSource } from "../../.upstream/apps/hosted/server/src/contracts/pool-defaults.ts";
import { ScheduleWakeup } from "../../.upstream/apps/hosted/server/src/contracts/schedules.ts";
import { migrateGroups } from "../../.upstream/apps/hosted/server/src/implementation/group-schema.ts";
import { poolAccessLifecycle } from "../../.upstream/apps/hosted/server/src/implementation/pool-access-hook.ts";
import { poolAccountRecovery } from "../../.upstream/apps/hosted/server/src/implementation/pool-account-recovery.ts";
import { createPool } from "../../.upstream/apps/hosted/server/src/implementation/pools.ts";
import {
  drainProvisioning,
  provision,
  selfHostProvisioningServices,
} from "../../.upstream/apps/hosted/server/src/implementation/provisioning.ts";
import { migrateProvisioning } from "../../.upstream/apps/hosted/server/src/implementation/provisioning-schema.ts";
import { hostedResourceLifecycle } from "../../.upstream/apps/hosted/server/src/implementation/resource-lifecycle.ts";
import { visibleApps } from "../../.upstream/apps/hosted/server/src/implementation/resource-policy.ts";
import { callerHeader } from "../../apps/pool/contract.ts";
import { accessPath } from "../../src/pool/access-contract.ts";
import { requirePoolUse } from "../../src/pool/authorization.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { Computers } from "../../src/pool/computers.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { membershipPath } from "../../src/pool/membership-contract.ts";
import { NativeMemberships } from "../../src/pool/membership.ts";

const organization = OrganizationId.make("org-pool-creation");
const owner = "person-owner";
const admin = "person-admin";
const key = "ab".repeat(32);
const requirements = {
  accounts: {
    pool: {
      provider: "prv_pool_creation",
      scope: "app",
      cardinality: "one",
      definition: {
        name: "Pool",
        auth: {
          token: {
            type: "secrets",
            label: "Pool access",
            fields: {
              type: "object",
              properties: { token: { type: "string", minLength: 1 } },
              required: ["token"],
            },
          },
        },
      },
    },
  },
};

/**
 * The pool Worker's own receivers for the two paths the host posts to, on a loopback socket. The
 * Worker class itself needs the Workers runtime; its routing for these paths is the few lines in
 * `receive`. Until `answer` is called it drops every connection, as an unreachable Worker does.
 */
const poolWorker = Effect.acquireRelease(
  Effect.promise(async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
      put: async (name: string, value: unknown) => {
        values.set(name, structuredClone(value));
      },
    };
    const computers = new Computers({
      storage,
      signingKey: key,
      // A new private pool has no one to provision or revoke, so Home is never called.
      home: new ComputerHome(
        new HomeClient(async () => {
          throw new Error("Pool creation reached Home");
        }),
      ),
    });
    const memberships = new NativeMemberships({
      storage,
      signingKey: key,
      read: async (pool, team) => ({ pool, organization: team, native: true, accounts: [] }),
      actual: async () => [],
      reconcile: async () => {},
      install: async () => {},
      abort: () => {},
      schedule: async () => {},
    });
    const state = { answering: false, origin: "" };
    const receive = async (incoming: IncomingMessage) => {
      const { pathname } = new URL(incoming.url ?? "/", state.origin);
      const request = new Request(new URL(pathname, state.origin), {
        method: incoming.method ?? "GET",
        headers: { "content-type": "application/json" },
        body: await text(incoming),
      });
      if (pathname === accessPath) return computers.access(request);
      if (pathname !== membershipPath) return new Response(null, { status: 404 });
      await memberships.reserve(request);
      return new Response(null, { status: 204 });
    };
    const server = createServer((incoming, outgoing) => {
      if (!state.answering) {
        incoming.socket.destroy();
        return;
      }
      receive(incoming).then(
        async (answer) => {
          outgoing.writeHead(answer.status, { "content-type": "application/json" });
          outgoing.end(await answer.text());
        },
        () => {
          outgoing.writeHead(503);
          outgoing.end();
        },
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    state.origin = `http://127.0.0.1:${address.port}`;
    return {
      server,
      origin: state.origin,
      answer: () => {
        state.answering = true;
      },
      /** Undefined until the Worker has the pool's native policy; it then decides use. */
      permissions: (pool: string, user: string) => computers.permissions(pool, user),
      membership: (pool: string) => memberships.inspect(pool),
    };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

type Services =
  | SqlClient.SqlClient
  | Crypto.Crypto
  | HostedExecutor
  | GroupDatabase
  | CurrentOrganization
  | PoolAppSource
  | ScheduleWakeup
  | OrganizationDefaults;

/**
 * The real creation service, access hook, resource policy hooks, account linking and provisioning
 * queue over real SQL. Only compilation is replaced: `copy` persists the app as the SDK does,
 * inside one transaction that runs the product's hooks.
 */
const fixture = <E>(
  run: (context: {
    readonly sql: SqlClient.SqlClient;
    readonly worker: Effect.Success<typeof poolWorker>;
    readonly create: (requestId: string) => ReturnType<typeof createPool>;
  }) => Effect.Effect<void, E, Services>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const worker = yield* poolWorker;
        for (const statement of [
          "create table organization (id text primary key, metadata text, slug text)",
          "create table hosted_organization_removal (organization_id text primary key)",
          'create table "user" (id text primary key, name text, email text, "emailVerified" boolean)',
          'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
          "create table executor_apps (id text primary key, owner text, name text unique, active_deployment text, copied_from jsonb, created_at timestamptz default now())",
          "create table executor_deployments (id text primary key, requirements jsonb, app text)",
          "create table executor_accounts (id text primary key, owner text, provider text, token text, method text, label text, credential_generation integer not null default 0)",
          "create table executor_account_acquisitions (account text primary key, owner text not null, provider text not null, method text not null, driver text not null, driver_revision text not null, generation integer not null, revision text not null, removal jsonb default null, mirror_ready boolean not null default false)",
          "create table executor_account_connections (id text primary key, owner text, state jsonb, created_at timestamptz default now())",
          "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text default gen_random_uuid()::text)",
          "create table hosted_account_access (account_id text, organization_id text, creator_id text, kind text, personal_user_id text)",
          "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
        ])
          yield* sql.unsafe(statement);
        yield* migrateGroups;
        yield* sql`create table hosted_app_groups (organization_id text, app_id text,
          group_id text references hosted_groups(id) on delete cascade)`;
        yield* sql`insert into organization (id, metadata) values (${organization}, '{}')`;
        yield* sql`insert into "user" values (${owner}, 'Owner', 'owner@example.invalid', true),
          (${admin}, 'Admin', 'admin@example.invalid', true)`;
        yield* sql`insert into member values ('member-owner', ${organization}, ${owner}, 'owner'),
          ('member-admin', ${organization}, ${admin}, 'admin')`;
        // The real queue, installed after the people exist so their own setup jobs are not queued.
        yield* migrateProvisioning;
        const hook = poolAccessLifecycle(Option.some(Redacted.make(key)), worker.origin);
        const lifecycle = yield* hostedResourceLifecycle.pipe(
          Effect.provideService(AccessLifecycle, hook),
        );
        let serial = 0;
        const get = (id: typeof AppId.Type) =>
          Effect.gen(function* () {
            const [row] = yield* sql<{
              owner: string;
              name: string;
              active_deployment: string | null;
              copied_from: unknown;
            }>`select owner, name, active_deployment, copied_from from executor_apps where id = ${id}`;
            if (row === undefined) return yield* new AppNotFound({ app: id });
            return {
              id,
              owner: row.owner,
              name: row.name,
              activeVersion: row.active_deployment,
              copiedFrom: row.copied_from,
              requirements,
            } as unknown as App;
          });
        const executor = {
          [StorageHost]: { transaction: sql.withTransaction },
          apps: {
            get: ({ app }: { app: typeof AppId.Type }) => get(app),
            copy: (input: Parameters<Executor["apps"]["copy"]>[0]) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* lifecycle.hooks.appDeploying?.(input.owner) ?? Effect.void;
                  const taken = yield* sql`select id from executor_apps where name = ${input.name}`;
                  if (taken.length > 0)
                    return yield* new AppNameTaken({ owner: input.owner, name: input.name });
                  const id = AppId.make(`app_creation_${++serial}`);
                  const version = VersionId.make(`dpl_creation_${++serial}`);
                  const origin =
                    typeof input.from !== "string" && "origin" in input.from
                      ? input.from.origin
                      : null;
                  yield* sql`insert into executor_apps (id, owner, name, active_deployment, copied_from)
                    values (${id}, ${input.owner}, ${input.name}, ${version}, ${JSON.stringify(origin)}::jsonb)`;
                  yield* sql`insert into executor_deployments
                    values (${version}, ${JSON.stringify(requirements)}::jsonb, ${id})`;
                  const app = yield* get(id);
                  yield* lifecycle.hooks.appCreated(app);
                  return app;
                }),
              ),
          },
          managedAccounts: {
            readCredentials: (input: { account: string; owner: string }) =>
              Effect.gen(function* () {
                const [row] = yield* sql<{ token: string }>`select token from executor_accounts
                  where id = ${input.account} and owner = ${input.owner}`;
                if (row === undefined)
                  return yield* new AccountNotFound({ account: AccountId.make(input.account) });
                return Redacted.make({ token: row.token });
              }),
            add: (input: Parameters<Executor["managedAccounts"]["add"]>[0]) =>
              Effect.gen(function* () {
                const id = AccountId.make(`acc_creation_${++serial}`);
                const { token } = Redacted.value(input.fields);
                yield* sql`insert into executor_accounts (id, owner, provider, token, method, label)
                  values (${id}, ${input.owner}, ${input.provider}, ${String(token)}, ${input.method}, ${input.label})`;
                const account = { id, owner: input.owner } as Account;
                yield* lifecycle.hooks.accountCreated(account);
                return account;
              }),
          },
          webhooks: { sources: () => Effect.succeed([]), link: () => Effect.void },
        } as unknown as Executor;
        yield* lifecycle.attach(executor);
        const files = yield* Schema.decodeUnknownEffect(SourceFiles)([
          { path: "index.ts", content: "export {};\n" },
        ]);
        yield* run({
          sql,
          worker,
          create: (requestId) =>
            createPool({ name: "Research pool", requestId, newInstance: true }),
        }).pipe(
          Effect.provideService(HostedExecutor, Effect.succeed(executor)),
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(CurrentUserId, owner),
          Effect.provideService(CurrentOrganization, {
            organization,
            owner: organizationOwner(organization),
            role: "owner",
          }),
          Effect.provideService(AccessLifecycle, hook),
          Effect.provideService(PoolAppSource, {
            version: "pool-creation-fixture",
            files: Effect.succeed(files),
          }),
          Effect.provideService(ScheduleWakeup, Effect.void),
          // An access job never runs member setup; one that did would be recorded as a pool here.
          Effect.provideService(OrganizationDefaults, () => Effect.void),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ POOL_APP_SIGNING_KEY: key }),
          ),
        );
      }),
    ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeCrypto.layer)),
  );

const firstRequest = "0b0f5f0c-2b1a-4c9e-9a51-6d3f0f1c2a01";
const pools = (sql: SqlClient.SqlClient) =>
  sql<{ id: string }>`select id from executor_apps order by id`;
const jobs = (sql: SqlClient.SqlClient) =>
  sql<{ id: string; status: string; attempts: number }>`select id, status, attempts
    from hosted_provisioning order by id`;

test("creating a pool answers with the pool and lists it while the pool Worker does not answer", async () => {
  await fixture(({ sql, worker, create }) =>
    Effect.gen(function* () {
      const answer = yield* Effect.exit(create(firstRequest));
      assert.ok(Exit.isSuccess(answer), "creation must not fail for a pool it committed");
      const created = answer.value;
      assert.equal(created.name, "Research pool");
      assert.equal(created.reused, false);
      assert.deepEqual(yield* pools(sql), [{ id: created.id }]);
      const listed = yield* visibleApps([created]);
      assert.deepEqual(
        listed.map((app) => app.id),
        [created.id],
      );
      // The Worker has heard nothing, and the owner's pool token already admits them there.
      assert.equal(yield* Effect.promise(() => worker.permissions(created.id, owner)), undefined);
      const [account] = yield* sql<{ token: string }>`select token from executor_accounts`;
      assert.ok(account);
      const admitted = yield* Effect.promise(() =>
        requirePoolUse(
          new Request(`${worker.origin}/pool/v1/computers`, {
            headers: { authorization: `Bearer ${account.token}`, [callerHeader]: owner },
          }),
          { signingKey: key, permissions: worker.permissions },
        ),
      );
      assert.equal(admitted?.pool, created.id);
      assert.equal(admitted?.owner, owner);
    }),
  );
});

test("the queue delivers a new pool's audience once the pool Worker answers, without another request", async () => {
  await fixture(({ sql, worker, create }) =>
    Effect.gen(function* () {
      yield* Effect.exit(create(firstRequest));
      const [pool] = yield* pools(sql);
      assert.ok(pool);
      // The queue's own scan finds the job; the attempt fails and the job stays for a retry.
      yield* drainProvisioning(selfHostProvisioningServices);
      const waiting = yield* jobs(sql);
      assert.deepEqual(
        waiting.map((job) => [job.status, job.attempts]),
        [["queued", 1]],
        "the audience waits in the queue while the pool Worker does not answer",
      );
      assert.equal(yield* Effect.promise(() => worker.permissions(pool.id, owner)), undefined);
      worker.answer();
      // The queue runs this same attempt again after its backoff; nothing asks for it.
      for (const job of waiting) yield* provision(job.id, selfHostProvisioningServices);
      assert.deepEqual(
        (yield* jobs(sql)).map((job) => [job.status, job.attempts]),
        [["succeeded", 2]],
      );
      // The Worker's own records: the pool's native policy and its membership reservation.
      assert.deepEqual(yield* Effect.promise(() => worker.permissions(pool.id, owner)), {
        canUse: true,
        canManage: true,
      });
      assert.deepEqual(yield* Effect.promise(() => worker.permissions(pool.id, admin)), {
        canUse: false,
        canManage: true,
      });
      const { policy } = yield* Effect.promise(() => worker.membership(pool.id));
      assert.equal(policy?.native, true);
      assert.equal(policy?.organization, organization);
    }),
  );
});

test("retrying a creation request while the pool Worker is down returns the same pool and creates nothing", async () => {
  await fixture(({ sql, create }) =>
    Effect.gen(function* () {
      yield* Effect.exit(create(firstRequest));
      const [pool] = yield* pools(sql);
      assert.ok(pool);
      const queued = yield* jobs(sql);
      const retry = yield* Effect.exit(create(firstRequest));
      assert.ok(Exit.isSuccess(retry), "a retry must return the pool the first request committed");
      assert.equal(retry.value.id, pool.id);
      assert.equal(retry.value.reused, true);
      assert.deepEqual(yield* pools(sql), [pool]);
      assert.deepEqual(yield* jobs(sql), queued);
      const [recorded] = yield* sql<{ pools: number }>`select
        (select count(*)::int from jsonb_object_keys(metadata::jsonb -> 'basaltPools')) as pools
        from organization where id = ${organization}`;
      assert.equal(recorded?.pools, 1);
    }),
  );
});

test("a pool's waiting audience is not taken for the owner's setup job", async () => {
  await fixture(({ sql, worker, create }) =>
    Effect.gen(function* () {
      worker.answer();
      const created = yield* create(firstRequest);
      yield* sql`delete from hosted_app_account_links`;
      const before = yield* jobs(sql);
      const state = yield* poolAccountRecovery(true)({
        sql,
        organization,
        app: created,
        requirement: "pool",
      });
      assert.equal(state, "restoring");
      // Recovery queues the setup that restores the link; it never reuses the access job.
      assert.equal((yield* jobs(sql)).length, before.length + 1);
    }),
  );
});
