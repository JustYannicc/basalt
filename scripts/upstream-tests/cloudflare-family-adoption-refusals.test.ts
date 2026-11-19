import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  apply,
  dryRun,
  everything,
  holdNextBuild,
  ownerOf,
  productionMigrations,
  reasonOf,
  run,
  selection,
  teamA,
  teamB,
  world,
  type World,
} from "./cloudflare-family-fixture.ts";

// One test per refusal. Each starts from the full fixture, changes one thing and expects exactly
// that refusal from the production-operations runner, with nothing written.
const tested = new Set<string>();
const refuses = (
  reason: string,
  arrange: (
    w: World,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
) => {
  tested.add(reason);
  test(`family adoption refuses: ${reason}`, () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const w = yield* world;
        const request = (yield* arrange(w, sql)) ?? w.requestA;
        const before = yield* everything;
        assert.equal(yield* reasonOf(dryRun(request)), reason);
        assert.deepEqual(yield* everything, before);
      }),
    ));
};

refuses("family-ref-changed", (w) => Effect.succeed({ ...w.requestA, to: w.retained }));
refuses("already-family", (w) => Effect.succeed({ ...w.requestA, from: w.family }));
// A database where no app or pool ever stored the family's provider.
refuses("family-provider-missing", (w, sql) =>
  sql`delete from executor_providers where id = ${w.family}`.pipe(Effect.as(undefined)),
);
refuses("retained-provider-not-family", (w) =>
  Effect.succeed({
    ...w.requestA,
    from: w.other,
    accounts: [{ account: "acc_jira", generation: 1 }],
  }),
);
refuses("account-set-changed", (w) =>
  Effect.succeed({
    ...w.requestA,
    accounts: [
      { account: "acc_oauth", generation: 1 },
      { account: "acc_token", generation: 2 },
    ],
  }),
);
refuses("account-method-outside-family", (w, sql) =>
  Effect.gen(function* () {
    yield* sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at,credential_generation)
      values ('acc_legacy',${ownerOf(teamA)},${w.retained},'legacyKey','Legacy',${new Uint8Array([3])},now(),1)`;
    return {
      ...w.requestA,
      accounts: [...w.requestA.accounts, { account: "acc_legacy", generation: 1 }],
    };
  }),
);
refuses("connection-in-progress", (w, sql) =>
  sql`insert into executor_account_connections (id,owner,provider,reconnect_account,state,revision,oauth_attempt,created_at,expires_at,target)
    values ('con_pending',${ownerOf(teamA)},${w.retained},null,${JSON.stringify({ status: "pending" })},'r1',null,now(),now() + interval '1 hour',${JSON.stringify({ app: w.toolA, requirement: "cloudflare" })})`.pipe(
    Effect.as(undefined),
  ),
);
refuses("acquisition-outside-selection", (w, sql) =>
  sql`insert into executor_account_acquisitions (account,owner,provider,method,driver,driver_revision,generation,revision)
    values ('acc_jira',${ownerOf(teamA)},${w.retained},'apiToken','fixture','1',1,'r1')`.pipe(
    Effect.as(undefined),
  ),
);
// Clients saved before issuer keys derive their credential IDs from the provider ref.
refuses("provider-keyed-oauth-client", (w, sql) =>
  sql`insert into executor_stored_oauth_clients (id,owner,provider,issuer,client_id,source,has_secret,automatic_key,confirmed,encrypted,created_at)
    values ('ocl_legacy',${ownerOf(teamA)},${w.retained},null,'client','manual',false,null,true,${new Uint8Array([4])},now())`.pipe(
    Effect.as(undefined),
  ),
);
// A link the person already moved onto an app on the family ref.
refuses("link-unresolved", (w, sql) =>
  sql`insert into hosted_app_account_links values (${w.pipeline},'cloudflare','user-a','acc_token','user-a',now())`.pipe(
    Effect.as(undefined),
  ),
);
refuses("release-in-flight", (_w, sql) =>
  sql`insert into hosted_provisioning (id,kind,organization_id,user_id)
    values ('basalt-catalog-apps:release-2:job-a','member',${teamA},'user-a')`.pipe(
    Effect.as(undefined),
  ),
);
// The catalog app's deploy has reserved its order and is still building.
refuses("deploy-in-flight", (w) =>
  Effect.gen(function* () {
    const hold = yield* holdNextBuild(w.holds);
    yield* Effect.forkDetach(w.redeploy(teamA, w.toolA));
    yield* Deferred.await(hold.reached);
    return undefined;
  }),
);

tested.add("release-in-flight");
test("family adoption refuses: release-in-flight, only for the organization's own catalog sweep", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const w = yield* world;
      const { go } = yield* dryRun(w.requestA);
      // Another organization's sweep and the organization's own setup jobs do not hold it.
      yield* sql`insert into hosted_provisioning (id,kind,organization_id,user_id) values
        ('basalt-catalog-apps:release-2:job-b','member',${teamB},'user-c'),
        (${`team-${teamA}`},'team',${teamA},null)`;
      assert.equal(yield* reasonOf(dryRun(w.requestA)), "succeeded");
      yield* sql`insert into hosted_provisioning (id,kind,organization_id,user_id,status)
        values ('basalt-catalog-apps:release-2:job-a','member',${teamA},'user-a','running')`;
      const before = yield* everything;
      assert.equal(yield* reasonOf(apply(go)), "release-in-flight", "the GO runs the check itself");
      assert.deepEqual(yield* everything, before);
      yield* sql`update hosted_provisioning set status = 'succeeded' where id = 'basalt-catalog-apps:release-2:job-a'`;
      const applied = yield* apply(go);
      assert.ok(applied.action === "apply" && applied.repeated === false);
    }),
  ));

tested.add("reviewed-plan-changed");
test("family adoption refuses: reviewed-plan-changed, behind the runner's own comparison", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const w = yield* world;
      const { go, plan } = yield* dryRun(w.requestA);
      const migration = productionMigrations[selection];
      assert.ok(migration);
      const altered = { ...plan, data: { ...plan.data, links: [] } };
      const before = yield* everything;
      assert.equal(
        yield* reasonOf(sql.withTransaction(migration.apply(w.requestA, altered))),
        "reviewed-plan-changed",
      );
      assert.deepEqual(yield* everything, before);
      // Through the runner, a change after review stops the GO before the module's apply runs.
      yield* sql`insert into hosted_app_account_links values (${w.toolA},'cloudflare','user-c','acc_token','user-c',now())`;
      assert.equal(
        yield* reasonOf(apply(go)),
        "ProductionOperationRefused: Migration inputs changed after review",
      );
    }),
  ));

/** A write the adoption makes is changed underneath it by a trigger the test installs. */
const refusesAtApply = (reason: string, table: string, body: string) => {
  tested.add(reason);
  test(`family adoption refuses: ${reason}`, () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const w = yield* world;
        const { go } = yield* dryRun(w.requestA);
        yield* sql.unsafe(
          `create function interfere() returns trigger language plpgsql as $$ begin ${body} end $$`,
        );
        yield* sql.unsafe(
          `create trigger interfere before update on ${table} for each row execute function interfere()`,
        );
        const before = yield* everything;
        assert.equal(yield* reasonOf(apply(go)), reason);
        assert.deepEqual(yield* everything, before, "nothing is left behind and no receipt exists");
        yield* sql.unsafe(`drop trigger interfere on ${table}`);
        const applied = yield* apply(go);
        assert.ok(
          applied.action === "apply" && applied.repeated === false,
          "the same GO applies afterwards",
        );
      }),
    ));
};

refusesAtApply("write-count-changed", "executor_account_connections", "return null;");
refusesAtApply(
  "post-write-checks-failed",
  "executor_accounts",
  "new.label := new.label || ' (renamed)'; return new;",
);

test("every refusal reason has its own test, and the operator decodes each one", async () => {
  const runtime = (await import(
    new URL(
      "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/migrations/cloudflare-family-adoption-v1.ts",
      import.meta.url,
    ).href
  )) as { cloudflareFamilyAdoptionReasons: readonly string[] };
  const operator = await import("../production-ops/cloudflare-family-adoption-reasons.ts");
  assert.deepEqual(
    operator.cloudflareFamilyAdoptionReasons,
    runtime.cloudflareFamilyAdoptionReasons,
  );
  assert.deepEqual([...tested].sort(), [...runtime.cloudflareFamilyAdoptionReasons].sort());
});
