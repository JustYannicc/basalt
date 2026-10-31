import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { openEnvelope } from "../../src/pool/token.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const signingKey = "ab".repeat(32);
const organization = "org_reconnect";
const pool = "app_reconnect";
const account = "acc_reconnect";
const owner = `organization:${organization}`;
const provider = "prv_home";
const connection = "cnx_reconnect";

test("reconnect reserves an unchanged native app link before its new binding commits", async () => {
  const [sdk, lifecycleModule, accessContract, membershipHook, auth] = await Promise.all([
    load("packages/sdk/src/core.ts"),
    load("apps/hosted/server/src/implementation/resource-lifecycle.ts"),
    load("apps/hosted/server/src/contracts/access-lifecycle.ts"),
    load("apps/hosted/server/src/implementation/pool-access-hook.ts"),
    load("apps/hosted/server/src/contracts/auth.ts"),
  ]);
  const requests: Array<{ pool: string; organization: string }> = [];
  let responseStatus = 204;
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
      };
      requests.push(value);
      response.writeHead(responseStatus);
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
  const accessLifecycle = membershipHook.poolAccessLifecycle(
    Option.some(Redacted.make(signingKey)),
    `http://127.0.0.1:${address.port}`,
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const statement of [
            "create table organization (id text primary key, metadata text)",
            'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
            "create table executor_apps (id text primary key, owner text, name text, active_deployment text)",
            "create table executor_deployments (id text primary key, requirements jsonb)",
            "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text)",
            "create table hosted_connection_access (connection_id text primary key, organization_id text, target jsonb, creator_id text, destination jsonb)",
            "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text, creator_id text, audience text)",
            "create table hosted_account_groups (account_id text, group_id text)",
            "create table hosted_group_members (group_id text, member_id text)",
            "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
            "create unique index hosted_app_account_links_one on hosted_app_account_links (app, requirement, coalesce(subject, ''), account)",
            "create table executor_accounts (id text primary key, owner text, provider text, method text, credential_generation integer)",
            "create table executor_account_acquisitions (account text primary key, owner text, provider text, method text, generation integer, driver text, driver_revision text, revision text, removal jsonb)",
            "create table executor_account_connections (id text primary key, owner text, state jsonb, created_at timestamptz)",
          ])
            yield* sql.unsafe(statement);
          const required = {
            accounts: {
              home: {
                scope: "app",
                provider,
                cardinality: "one",
                definition: { auth: { apiKey: { type: "apiKey" } } },
              },
            },
          };
          yield* sql`insert into organization values (${organization}, ${JSON.stringify({
            basaltPools: { owner: { app: pool, membership: "executor-links-v1" } },
          })})`;
          yield* sql`insert into member values ('member-owner', ${organization}, 'owner', 'owner')`;
          yield* sql`insert into executor_deployments values ('dpl_reconnect', ${JSON.stringify(required)})`;
          yield* sql`insert into executor_apps values (${pool}, ${owner}, 'Reconnect', 'dpl_reconnect')`;
          yield* sql`insert into hosted_app_access values (${pool}, ${organization}, 'owner', 'private')`;
          yield* sql`insert into hosted_connection_access values
            (${connection}, ${organization}, ${JSON.stringify({ scope: "app", app: pool, requirement: "home" })}, 'owner', '{}')`;
          yield* sql`insert into hosted_account_access values
            (${account}, ${organization}, 'shared', null, 'owner', 'everyone')`;
          yield* sql`insert into hosted_app_account_links values
            (${pool}, 'home', null, ${account}, 'owner', now())`;
          yield* sql`insert into executor_accounts values (${account}, ${owner}, ${provider}, 'apiKey', 3)`;
          yield* sql`insert into executor_account_acquisitions values
            (${account}, ${owner}, ${provider}, 'apiKey', 3, 'basalt-home', 'home-r1', 'binding-r3', null)`;
          yield* sql`insert into executor_account_connections values
            ('saved-connection', ${owner}, ${JSON.stringify({ status: "completed", account: { id: account } })}, now())`;

          const lifecycle = yield* lifecycleModule.hostedResourceLifecycle.pipe(
            Effect.provideService(accessContract.AccessLifecycle, accessLifecycle),
          );
          const fakeExecutor = {
            [sdk.StorageHost]: {
              transaction: (effect: Effect.Effect<unknown>) => sql.withTransaction(effect),
            },
            webhooks: {
              sources: () => Effect.succeed([]),
              link: () => Effect.void,
              unlink: () => Effect.void,
            },
          };
          yield* lifecycle.attach(fakeExecutor);
          const complete = (generation: number) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`update executor_accounts set credential_generation = ${generation} where id = ${account}`;
                yield* sql`update executor_account_acquisitions set generation = ${generation}, revision = ${`binding-r${generation}`} where account = ${account}`;
                yield* lifecycle.hooks
                  .appAccountConnected({
                    connection,
                    app: pool,
                    requirement: "home",
                    scope: "app",
                    account: {
                      id: Schema.decodeUnknownSync(sdk.AccountId)(account),
                      owner: Schema.decodeUnknownSync(sdk.OwnerId)(owner),
                    },
                  })
                  .pipe(
                    Effect.provideService(auth.CurrentUserId, "owner"),
                    Effect.provideService(sdk.InteractiveRemovalDone, new Set()),
                  );
              }),
            );

          yield* complete(4);
          assert.deepEqual(
            requests.map(({ pool: receivedPool, organization: receivedOrg }) => [
              receivedPool,
              receivedOrg,
            ]),
            [[pool, organization]],
          );
          assert.deepEqual(
            yield* sql`select credential_generation from executor_accounts where id = ${account}`,
            [{ credential_generation: 4 }],
          );
          assert.equal(
            (yield* sql`select account from hosted_app_account_links where app = ${pool}`).length,
            1,
          );

          responseStatus = 503;
          const refused = yield* Effect.exit(
            complete(5).pipe(
              Effect.provideService(auth.CurrentUserId, "owner"),
              Effect.provideService(sdk.InteractiveRemovalDone, new Set()),
            ),
          );
          assert.equal(refused._tag, "Failure");
          assert.deepEqual(
            yield* sql`select credential_generation from executor_accounts where id = ${account}`,
            [{ credential_generation: 4 }],
          );
        }).pipe(Effect.provide(pgliteLayer())) as Effect.Effect<void, unknown, never>,
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
