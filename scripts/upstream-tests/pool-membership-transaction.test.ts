import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);

test("native membership rechecks its acquisition binding through the tracked ORM transaction", async () => {
  const [sdk, membership, runtime] = await Promise.all([
    load("packages/sdk/src/core.ts"),
    load("apps/hosted/server/src/implementation/pool-membership.ts"),
    load("packages/sdk/src/implementation/account-acquisition-runtime.ts"),
  ]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    const db = storage.orm("4.0.22");
    const organization = "org_membership_transaction";
    const owner = sdk.OwnerId.make(`organization:${organization}`);
    const account = sdk.AccountId.make("acc_membership_transaction");
    const pool = sdk.AppId.make("app_membership_transaction");
    const provider = sdk.ProviderId.make("prv_membership_transaction");
    for (const statement of [
      "create table organization (id text primary key, metadata text)",
      'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
      "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text, creator_id text)",
      "create table hosted_app_account_links (app text, requirement text, subject text, account text, created_at timestamptz)",
    ]) yield* sql.unsafe(statement);
    yield* sql`insert into organization values (${organization}, ${JSON.stringify({
      basaltPools: { fixture: { app: pool, membership: "executor-links-v1" } },
    })})`;
    yield* sql`insert into executor_deployments
      (id, code, owner, build, requirements, created_at, source_commit, file_count)
      values ('dpl_membership_transaction', 'code_membership_transaction', ${owner},
        'build_membership_transaction', ${JSON.stringify({ accounts: { home: { scope: "app", provider } } })},
        now(), null, 1)`;
    yield* sql`insert into executor_apps
      (id, code, repository, owner, name, active_deployment, copied_from, created_at, slug)
      values (${pool}, 'code_membership_transaction', null, ${owner}, 'Pool',
        'dpl_membership_transaction', null, now(), 'pool')`;
    yield* db.create("providers", { id: provider, definition: {} });
    yield* db.create("accounts", {
      id: account, owner, provider, method: "apiKey", label: "Fixture", description: null,
      encryptedCredentials: new Uint8Array([1]), credentialGeneration: 2,
      createdAt: new Date("2026-01-01T00:00:00Z"), site: null, allowedHosts: null,
    });
    yield* db.create("accountAcquisitions", {
      account, owner, provider, method: "apiKey", generation: 2,
      driver: "basalt-home", driverRevision: "home-r1", revision: "binding-r1", removal: null,
    });
    yield* sql`insert into hosted_account_access values (${account}, ${organization}, 'shared', null, 'owner')`;
    yield* sql`insert into hosted_app_account_links values (${pool}, 'home', null, ${account}, now())`;
    // The production source.current locks both ORM rows, even when their values stay the same.
    yield* sql`create table binding_rechecks (account text)`;
    yield* sql.unsafe(`create function record_binding_recheck() returns trigger language plpgsql as $$
      begin insert into binding_rechecks values (new.account); return new; end $$`);
    yield* sql.unsafe(`create trigger record_binding_recheck after update on executor_account_acquisitions
      for each row execute function record_binding_recheck()`);
    const source = runtime.makeAcquisitionRuntime(db, {
      decrypt: () => Effect.succeed(Redacted.make({ ref: "opaque-home-reference" })),
    }, {}, {
      retained: () => Effect.succeed({
        exposeHostReference: true,
        driver: { id: "basalt-home", revision: "home-r1" },
      }),
    }).source;
    const executor = {
      [sdk.AccountAcquisitionHost]: { source },
      [sdk.StorageHost]: { transaction: db.transaction },
    };
    const result = yield* membership.nativePoolMembership(organization, pool, executor);
    assert.equal(result.native, true);
    assert.deepEqual(result.accounts.map((row: { account: string; homeReference: string | null }) =>
      ({ account: row.account, homeReference: row.homeReference })),
    [{ account, homeReference: "opaque-home-reference" }]);
    assert.deepEqual(yield* sql`select account from binding_rechecks`, [{ account }]);
    const retained = yield* db.findFirst("accountAcquisitions", {
      where: (b: (name: string, operator: string, value: string) => unknown) => b("account", "=", account),
    });
    assert.equal(retained.revision, "binding-r1");
    assert.equal(retained.generation, 2);
  }).pipe(Effect.provide(pgliteLayer()))) as Effect.Effect<void, unknown>);
});
