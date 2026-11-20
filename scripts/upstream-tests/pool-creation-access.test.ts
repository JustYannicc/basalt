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
 * queue over real SQL. The SDK is a small stand-in, because a real copy compiles the app: `copy`,
 * `get` and the managed-account calls write the rows the product reads, inside one transaction
 * that runs the product's own hooks.
 */
const fixture = <E>(
  run: (context: {
    readonly sql: SqlClient.SqlClient;
    readonly worker: Effect.Success<typeof poolWorker>;
    readonly create: (requestId: string) => ReturnType<typeof createPool>;
    /** One pass of the queue's own worker over the jobs that are due. */
    readonly drain: ReturnType<typeof drainProvisioning>;
    /** Every member setup the queue or the defaults ran. An access job runs none. */
    readonly setups: readonly string[];
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
        const setups: string[] = [];
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
          drain: drainProvisioning({
            ...selfHostProvisioningServices,
            member: (user) => Effect.sync(() => void setups.push(`member ${user}`)),
          }),
          setups,
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
          Effect.provideService(OrganizationDefaults, (team, user) =>
            Effect.sync(() => void setups.push(`defaults ${team} ${user?.userId ?? ""}`)),
          ),
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
/** Each job's status and attempt count, the access job first. */
const attempts = (sql: SqlClient.SqlClient) =>
  sql<{ status: string; attempts: number }>`select status, attempts from hosted_provisioning
    order by attempts desc, id`.pipe(
    Effect.map((jobs) => jobs.map((job): [string, number] => [job.status, job.attempts])),
  );

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
      // The request tried the job once; it failed and is left for the queue.
      assert.deepEqual(yield* attempts(sql), [["queued", 1]]);
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
  await fixture(({ sql, worker, create, drain, setups }) =>
    Effect.gen(function* () {
      yield* Effect.exit(create(firstRequest));
      const [pool] = yield* pools(sql);
      assert.ok(pool);
      // The queue's own scan finds the job; its attempt fails too and the job stays.
      yield* drain;
      assert.deepEqual(
        yield* attempts(sql),
        [["queued", 2]],
        "the audience waits in the queue while the pool Worker does not answer",
      );
      assert.equal(yield* Effect.promise(() => worker.permissions(pool.id, owner)), undefined);
      worker.answer();
      // The backoff after the failed attempt has passed; nothing else asks for the delivery.
      yield* sql`update hosted_provisioning set available_at = now()`;
      yield* drain;
      assert.deepEqual(yield* attempts(sql), [["succeeded", 3]]);
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
      assert.deepEqual(setups, [], "an access job runs no member setup");
    }),
  );
});

test("a pool Worker that answers has the new pool's audience before creation answers", async () => {
  await fixture(({ sql, worker, create }) =>
    Effect.gen(function* () {
      worker.answer();
      const created = yield* create(firstRequest);
      assert.deepEqual(yield* Effect.promise(() => worker.permissions(created.id, owner)), {
        canUse: true,
        canManage: true,
      });
      assert.deepEqual(
        yield* attempts(sql),
        [["succeeded", 1]],
        "the request's own attempt settles the job, so the queue sends nothing more",
      );
    }),
  );
});

test("retrying a creation request while the pool Worker is down returns the same pool and creates nothing", async () => {
  await fixture(({ sql, create }) =>
    Effect.gen(function* () {
      yield* Effect.exit(create(firstRequest));
      const [pool] = yield* pools(sql);
      assert.ok(pool);
      const retry = yield* Effect.exit(create(firstRequest));
      assert.ok(Exit.isSuccess(retry), "a retry must return the pool the first request committed");
      assert.equal(retry.value.id, pool.id);
      assert.equal(retry.value.reused, true);
      assert.deepEqual(yield* pools(sql), [pool]);
      // Still the one job, tried once by each request.
      assert.deepEqual(yield* attempts(sql), [["queued", 2]]);
      const [recorded] = yield* sql<{ pools: number }>`select
        (select count(*)::int from jsonb_object_keys(metadata::jsonb -> 'basaltPools')) as pools
        from organization where id = ${organization}`;
      assert.equal(recorded?.pools, 1);
    }),
  );
});

test("retrying a creation request delivers an audience the queue had given up on", async () => {
  await fixture(({ sql, worker, create }) =>
    Effect.gen(function* () {
      yield* Effect.exit(create(firstRequest));
      const [pool] = yield* pools(sql);
      assert.ok(pool);
      // The queue's last attempt failed: nothing sends this job again on its own.
      yield* sql`update hosted_provisioning set status = 'failed', attempts = 8`;
      worker.answer();
      const retry = yield* Effect.exit(create(firstRequest));
      assert.ok(Exit.isSuccess(retry));
      assert.equal(retry.value.id, pool.id);
      assert.deepEqual(yield* attempts(sql), [["succeeded", 9]]);
      assert.deepEqual(yield* Effect.promise(() => worker.permissions(pool.id, owner)), {
        canUse: true,
        canManage: true,
      });
    }),
  );
});

test("repeating the request for a pool saved before access jobs existed still sends its audience", async () => {
  await fixture(({ sql, worker, create }) =>
    Effect.gen(function* () {
      yield* Effect.exit(create(firstRequest));
      const [pool] = yield* pools(sql);
      assert.ok(pool);
      // As an earlier release left it: the pool's app and record exist, and no job does.
      yield* sql`delete from hosted_provisioning`;
      worker.answer();
      const retry = yield* Effect.exit(create(firstRequest));
      assert.ok(Exit.isSuccess(retry));
      assert.equal(retry.value.id, pool.id);
      assert.deepEqual(yield* attempts(sql), [["succeeded", 1]]);
      assert.deepEqual(yield* Effect.promise(() => worker.permissions(pool.id, owner)), {
        canUse: true,
        canManage: true,
      });
    }),
  );
});

test("a pool's waiting or failed access job is not taken for the owner's setup job", async () => {
  await fixture(({ sql, create }) =>
    Effect.gen(function* () {
      const answer = yield* Effect.exit(create(firstRequest));
      assert.ok(Exit.isSuccess(answer), "creation must not fail for a pool it committed");
      const recover = poolAccountRecovery(true)({
        sql,
        organization,
        app: answer.value,
        requirement: "pool",
      });
      yield* sql`delete from hosted_app_account_links`;
      // Waiting: recovery queues the setup that restores the link beside the access job.
      assert.equal(yield* recover, "restoring");
      assert.deepEqual(
        (yield* attempts(sql)).map(([status]) => status),
        ["queued", "queued"],
      );
      // Given up on: a failed access job says nothing about a failed setup, so recovery still queues.
      yield* sql`delete from hosted_provisioning where attempts = 0`;
      yield* sql`update hosted_provisioning set status = 'failed', updated_at = now()`;
      assert.equal(yield* recover, "restoring");
      assert.deepEqual(
        (yield* attempts(sql)).map(([status]) => status),
        ["failed", "queued"],
      );
    }),
  );
});
