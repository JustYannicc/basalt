import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ConfigProvider, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { openEnvelope, signEnvelope } from "../../src/pool/token.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const signingKey = "ab".repeat(32);
const organization = "org_membership";
const pool = "app_membership";
const owner = `organization:${organization}`;
const requirements = (homeScope: "app" | "user" = "app") => ({
  accounts: {
    home: { scope: homeScope, provider: "prv_home" },
    other: { scope: homeScope, provider: "prv_other" },
    user: { scope: "user", provider: "prv_home" },
  },
});

const database = (
  run: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown, unknown>,
): Effect.Effect<unknown, unknown, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of [
        "create table organization (id text primary key, metadata text)",
        'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
        "create table executor_apps (id text primary key, owner text, name text, active_deployment text)",
        "create table executor_deployments (id text primary key, requirements jsonb)",
        "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text, creator_id text)",
        "create table hosted_app_account_links (app text, requirement text, subject text, account text, created_at timestamptz)",
        "create table executor_accounts (id text primary key, owner text, provider text, method text, credential_generation integer)",
        "create table executor_account_acquisitions (account text primary key, owner text, provider text, method text, generation integer, driver text, driver_revision text, revision text, removal jsonb)",
      ])
        yield* sql.unsafe(statement);
      yield* run(sql);
    }).pipe(Effect.provide(pgliteLayer())),
  ) as Effect.Effect<unknown, unknown, never>;

test("app-link reservations are signed, opt-in, cover each pool and fail the native transaction", async () => {
  const { poolAccessLifecycle } = await load(
    "apps/hosted/server/src/implementation/pool-access-hook.ts",
  );
  const delivered: Array<{ pool: string; organization: string }> = [];
  let status = 204;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/pool/v1/membership");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const { envelope } = JSON.parse(Buffer.concat(chunks).toString());
      const value = (await openEnvelope(signingKey, "sbm1", envelope)) as {
        pool: string;
        organization: string;
        at: number;
        expiresAt: number;
      };
      assert.equal(value.expiresAt - value.at, 30_000);
      delivered.push(value);
      response.writeHead(status);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const hook = poolAccessLifecycle(
    Option.some(Redacted.make(signingKey)),
    `http://127.0.0.1:${address.port}`,
  );
  try {
    await Effect.runPromise(
      database((sql) =>
        Effect.gen(function* () {
          yield* sql`insert into organization values (${organization}, ${JSON.stringify({
            basaltPools: {
              one: { app: "app_one", membership: "executor-links-v1" },
              two: { app: "app_two", membership: "executor-links-v1" },
              old: { app: "app_old" },
            },
          })})`;
          yield* sql`insert into executor_apps (id, owner, name) values
            ('app_one', ${owner}, 'One'), ('app_two', ${owner}, 'Two'), ('app_old', ${owner}, 'Old')`;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`create table native_link_write (id text primary key)`;
              yield* sql`insert into native_link_write values ('committed')`;
              yield* hook
                .appAccountLinksChanged({
                  apps: ["app_one", "app_two", "app_old"],
                })
                .pipe(Effect.provideService(SqlClient.SqlClient, sql));
            }),
          );
          assert.deepEqual(
            delivered.map(({ pool: value, organization: org }) => [value, org]),
            [
              ["app_one", organization],
              ["app_two", organization],
            ],
          );
          assert.deepEqual(yield* sql`select id from native_link_write`, [{ id: "committed" }]);
          yield* hook
            .appAccountLinksChanged({ apps: ["app_one"] })
            .pipe(Effect.provideService(SqlClient.SqlClient, sql));
          assert.deepEqual(delivered.at(-1)?.pool, "app_one");

          status = 503;
          const refused = yield* Effect.exit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`insert into native_link_write values ('must-rollback')`;
                yield* hook
                  .appAccountLinksChanged({ apps: ["app_one"] })
                  .pipe(Effect.provideService(SqlClient.SqlClient, sql));
              }),
            ),
          );
          assert.equal(refused._tag, "Failure");
          assert.deepEqual(yield* sql`select id from native_link_write`, [{ id: "committed" }]);
        }),
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the signed native reader returns only current app links and verified Home references", async () => {
  const [sdk, membership, hostedExecutor, groups] = await Promise.all([
    load("packages/sdk/src/core.ts"),
    load("apps/hosted/server/src/implementation/pool-membership.ts"),
    load("apps/hosted/server/src/contracts/executor.ts"),
    load("apps/hosted/server/src/contracts/groups.ts"),
  ]);
  const accountIds = [
    "acc_home",
    "acc_other",
    "acc_user",
    "acc_wrong",
    "acc_stale",
    "acc_retiring",
    "acc_left",
    "acc_changed",
    "acc_driver_changed",
  ];
  const provider = (id: string) => Schema.decodeUnknownSync(sdk.ProviderId)(id);
  const id = (account: string) => Schema.decodeUnknownSync(sdk.AccountId)(account);
  const binding = (account: string, revision: string, driver = "basalt-home") => ({
    account: id(account),
    owner: Schema.decodeUnknownSync(sdk.OwnerId)(owner),
    provider: provider(
      account === "acc_other" || account === "acc_wrong" ? "prv_other" : "prv_home",
    ),
    method: "apiKey",
    driver,
    driverRevision: "home-r1",
    generation: account === "acc_stale" ? 1 : 2,
    revision,
    removal: null,
  });
  const bindings = new Map(accountIds.map((account) => [account, binding(account, "binding-r1")]));
  const changed = binding("acc_changed", "binding-r2");
  const executor = {
    [sdk.AccountAcquisitionHost]: {
      source: ({ account }: { account: string }) => {
        const saved = bindings.get(account);
        if (saved === undefined) return Effect.succeed(undefined);
        const current = account === "acc_changed" ? changed : saved;
        return Effect.succeed({
          binding: saved,
          source: { kind: "driver", id: saved.driver, version: "home-r1" },
          hostReference:
            saved.driver === "basalt-home" ? Redacted.make(`home-ref-${account}`) : undefined,
          current: Effect.succeed(current),
        });
      },
    },
  };
  const routes = HttpRouter.add(
    "POST",
    membership.poolMembershipReadPath,
    membership.readNativePoolMembership,
  );
  await Effect.runPromise(
    database((sql) =>
      Effect.gen(function* () {
        yield* sql`insert into organization values (${organization}, ${JSON.stringify({
          basaltPools: { owner: { app: pool, membership: "executor-links-v1" } },
        })})`;
        yield* sql`insert into member values ('m-owner', ${organization}, 'owner', 'owner'), ('m-home', ${organization}, 'alice', 'member')`;
        yield* sql`insert into executor_apps values (${pool}, ${owner}, 'Pool', 'dpl_app')`;
        yield* sql`insert into executor_deployments values
            ('dpl_app', ${JSON.stringify(requirements())}),
            ('dpl_user', ${JSON.stringify(requirements("user"))})`;
        for (const [account, req, p, kind, personalUser, generation, driver, removal] of [
          ["acc_home", "home", "prv_home", "personal", "alice", 2, "basalt-home", null],
          ["acc_other", "other", "prv_other", "shared", null, 2, "other-driver", null],
          ["acc_user", "user", "prv_home", "shared", null, 2, "basalt-home", null],
          ["acc_wrong", "home", "prv_other", "shared", null, 2, "other-driver", null],
          ["acc_stale", "home", "prv_home", "shared", null, 2, "basalt-home", null],
          [
            "acc_retiring",
            "home",
            "prv_home",
            "shared",
            null,
            2,
            "basalt-home",
            JSON.stringify({ operation: "retire", removed: false }),
          ],
          ["acc_left", "home", "prv_home", "personal", "departed", 2, "basalt-home", null],
          ["acc_changed", "home", "prv_home", "shared", null, 2, "basalt-home", null],
          ["acc_driver_changed", "home", "prv_home", "shared", null, 2, "basalt-home", null],
        ] as const) {
          yield* sql`insert into hosted_account_access values
              (${account}, ${organization}, ${kind}, ${personalUser}, 'owner')`;
          yield* sql`insert into executor_accounts values
              (${account}, ${owner}, ${p}, 'apiKey', ${generation})`;
          yield* sql`insert into hosted_app_account_links values
              (${pool}, ${req}, null, ${account}, now())`;
          yield* sql`insert into executor_account_acquisitions values
              (${account}, ${owner}, ${p}, 'apiKey', ${account === "acc_stale" ? 1 : 2}, ${driver},
                ${account === "acc_driver_changed" ? "home-r0" : "home-r1"}, 'binding-r1', ${removal})`;
        }
        yield* sql`insert into hosted_account_access values
            ('acc_unbound', ${organization}, 'shared', null, 'owner')`;
        yield* sql`insert into executor_accounts values
            ('acc_unbound', ${owner}, 'prv_home', 'apiKey', 2)`;
        yield* sql`insert into hosted_app_account_links values
            (${pool}, 'home', null, 'acc_unbound', now())`;
        const [{ HostedExecutor }, { GroupDatabase }] = [hostedExecutor, groups];
        const services = yield* Layer.build(
          HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(HostedExecutor, Effect.succeed(executor)),
                Layer.succeed(GroupDatabase, Effect.succeed(sql)),
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({ POOL_APP_SIGNING_KEY: signingKey }),
                ),
              ),
            ),
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in server.address)) return yield* Effect.die("Expected TCP listener");
        const origin = `http://127.0.0.1:${server.address.port}`;
        const request = async (prefix: string, secret = signingKey) => {
          const envelope = await signEnvelope(secret, prefix, {
            pool,
            organization,
            at: Date.now(),
            expiresAt: Date.now() + 30_000,
          });
          return fetch(`${origin}${membership.poolMembershipReadPath}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ envelope }),
          });
        };
        const response = yield* Effect.tryPromise(() => request("sbq1"));
        assert.equal(response.status, 200);
        const body = (yield* Effect.tryPromise(() => response.json())) as {
          native: boolean;
          accounts: Array<Record<string, unknown>>;
        };
        assert.equal(body.native, true);
        const byId = new Map(body.accounts.map((account) => [account.account, account]));
        assert.deepEqual([...byId.keys()].sort(), [
          "acc_changed",
          "acc_driver_changed",
          "acc_home",
          "acc_other",
          "acc_unbound",
        ]);
        assert.equal(byId.get("acc_home")?.homeReference, "home-ref-acc_home");
        assert.equal(byId.get("acc_other")?.homeReference, null);
        assert.equal(byId.get("acc_changed")?.homeReference, null);
        assert.equal(byId.get("acc_driver_changed")?.homeReference, null);
        assert.equal(byId.get("acc_unbound")?.homeReference, null);
        assert.equal("owner" in byId.get("acc_home")!, false);
        assert.equal("label" in byId.get("acc_home")!, false);
        assert.equal(JSON.stringify(body).includes("alice"), false);
        assert.equal(JSON.stringify(body).includes("home-ref-acc_changed"), false);

        const denied = yield* Effect.tryPromise(() => request("sbm1"));
        assert.equal(denied.status, 503);
        const wrongKey = yield* Effect.tryPromise(() => request("sbq1", "cd".repeat(32)));
        assert.equal(wrongKey.status, 503);
        yield* sql`update executor_apps set active_deployment = 'dpl_user' where id = ${pool}`;
        const userVersion = yield* Effect.tryPromise(() => request("sbq1"));
        assert.deepEqual((yield* Effect.tryPromise(() => userVersion.json())).accounts, []);
        yield* sql`update executor_apps set active_deployment = 'dpl_app' where id = ${pool}`;
        yield* sql`delete from member where "userId" = 'alice'`;
        const personalOwnerLeft = yield* Effect.tryPromise(() => request("sbq1"));
        const afterMemberRemoval = (yield* Effect.tryPromise(() => personalOwnerLeft.json())) as {
          accounts: Array<{ account: string }>;
        };
        assert.deepEqual(afterMemberRemoval.accounts.map((account) => account.account).sort(), [
          "acc_changed",
          "acc_driver_changed",
          "acc_other",
          "acc_unbound",
        ]);
        yield* sql`update organization set metadata = '{}' where id = ${organization}`;
        const legacyPool = yield* Effect.tryPromise(() => request("sbq1"));
        assert.deepEqual(yield* Effect.tryPromise(() => legacyPool.json()), {
          pool,
          organization,
          native: false,
          accounts: [],
        });
      }),
    ),
  );
});
