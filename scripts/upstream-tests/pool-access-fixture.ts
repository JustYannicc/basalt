import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Context, Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import type { AccessEnvelope } from "../../src/pool/access-contract.ts";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
export const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
export const implementation = "apps/hosted/server/src/implementation/";
export const contracts = "apps/hosted/server/src/contracts/";
export const secret = "ab".repeat(32);
const { poolAccessLifecycle } = await load(`${implementation}pool-access-hook.ts`);
const { AccessLifecycle } = await load(`${contracts}access-lifecycle.ts`);
const { GroupDatabase } = await load(`${contracts}groups.ts`);
const { CurrentOrganization, OrganizationId, organizationOwner } = await load(
  `${contracts}organization.ts`,
);
const { CurrentUserId } = await load(`${contracts}auth.ts`);
const { migrateGroups } = await load(`${implementation}group-schema.ts`);
const InTransaction = Context.Reference<boolean>("pool-access-test/transaction", {
  defaultValue: () => false,
});
export const organization = Schema.decodeUnknownSync(OrganizationId)("org-fixture");

export async function fixture(run: (value: any) => Effect.Effect<unknown, unknown, any>) {
  const changes: AccessEnvelope[] = [];
  const requestTransactions: boolean[] = [];
  let status = 200;
  let loseNext = false;
  let currentTransaction = false;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/pool/v1/access");
      assert.equal(request.headers["content-type"], "application/json");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { envelope } = JSON.parse(Buffer.concat(chunks).toString());
      const value = (await openEnvelope(secret, "sba1", envelope)) as AccessEnvelope;
      assert.ok(value);
      assert.equal(value.expiresAt - value.at, 30_000);
      assert.ok(Math.abs(Date.now() - value.at) < 5_000);
      changes.push(value);
      requestTransactions.push(currentTransaction);
      if (loseNext) {
        loseNext = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ revoked: 0, provisioned: 0 }));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const hook = poolAccessLifecycle(Option.some(Redacted.make(secret)), origin);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* SqlClient.SqlClient;
          // Observe the actual transaction boundary used by shareApp and the group controllers.
          const sql = new Proxy(native, {
            get(target, property) {
              if (property !== "withTransaction") return Reflect.get(target, property);
              return (operation: Effect.Effect<any, any, any>) =>
                native.withTransaction(
                  Effect.acquireUseRelease(
                    Effect.sync(() => {
                      currentTransaction = true;
                    }),
                    () => operation.pipe(Effect.provideService(InTransaction, true)),
                    () =>
                      Effect.sync(() => {
                        currentTransaction = false;
                      }),
                  ),
                );
            },
          });
          for (const statement of [
            "create table organization (id text primary key, metadata text)",
            'create table "user" (id text primary key, name text, email text, "emailVerified" boolean)',
            'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
            "create table executor_apps (id text primary key, owner text, name text)",
            "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text default gen_random_uuid()::text)",
            "create table hosted_app_groups (organization_id text, app_id text, group_id text references hosted_groups(id) on delete cascade)",
            "create table hosted_app_account_links (app text)",
          ]) {
            if (statement.startsWith("create table hosted_app_groups"))
              yield* migrateGroups.pipe(Effect.provideService(SqlClient.SqlClient, sql));
            yield* sql.unsafe(statement);
          }
          yield* sql`insert into organization values (${organization}, ${JSON.stringify({ basaltPools: { owner: { app: "app_pool-fixture" } } })})`;
          yield* sql`insert into "user" values ('owner', 'Owner', 'owner@example.invalid', true), ('guest', 'Guest', 'guest@example.invalid', true), ('other', 'Other', 'other@example.invalid', true)`;
          yield* sql`insert into member values ('m-owner', ${organization}, 'owner', 'owner'), ('m-guest', ${organization}, 'guest', 'member'), ('m-other', ${organization}, 'other', 'admin')`;
          yield* sql`insert into executor_apps values ('app_pool-fixture', ${organizationOwner(organization)}, 'Fixture pool'), ('app_ordinary', ${organizationOwner(organization)}, 'Ordinary app')`;
          yield* sql`insert into hosted_app_access (id, organization_id, creator_id, audience) values ('app_pool-fixture', ${organization}, 'owner', 'private'), ('app_ordinary', ${organization}, 'owner', 'private')`;
          yield* run({
            sql,
            hook,
            changes,
            requestTransactions,
            origin,
            loseAcknowledgement: () => {
              loseNext = true;
            },
            fail: () => {
              status = 503;
            },
            recover: () => {
              status = 200;
            },
            noKey: poolAccessLifecycle(Option.none(), origin),
            transaction: (operation: any) => sql.withTransaction(operation),
            inTransaction: InTransaction,
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(GroupDatabase, Effect.succeed(sql)),
            Effect.provideService(AccessLifecycle, hook),
            Effect.provideService(CurrentUserId, "owner"),
            Effect.provideService(CurrentOrganization, {
              organization,
              owner: organizationOwner(organization),
              role: "owner",
            }),
          );
        }),
      ).pipe(Effect.provide(pgliteLayer())) as Effect.Effect<unknown, unknown>,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
