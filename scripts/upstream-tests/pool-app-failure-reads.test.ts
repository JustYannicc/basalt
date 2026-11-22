import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import * as sdk from "../../.upstream/packages/sdk/src/core.ts";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { HostedExecutor } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import {
  CurrentOrganization,
  OrganizationId,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { PoolUsageBackend } from "../../.upstream/apps/hosted/server/src/contracts/pool-usage.ts";
import { migrateContributedDepartures } from "../../.upstream/apps/hosted/server/src/implementation/contributed-departure-schema.ts";
import { registerContributedAccountSchema } from "../../.upstream/apps/hosted/server/src/implementation/app-link-schema.ts";
import { poolAppUsage } from "../../.upstream/apps/hosted/server/src/implementation/pool-app-ui.ts";
import { poolAppUsageSummary } from "../../.upstream/apps/hosted/server/src/implementation/pool-summary-app-ui.ts";
import { refusalTag, responseBody, routeTag, underSentry } from "./pool-app-failure-fixture.ts";

// The pool and one linked home account, as the shared-authority Postgres fixtures seed them.
const app = sdk.AppId.make("app_pool_failure_reads");
const organization = OrganizationId.make("org_pool_failure_reads");
const owner = `organization:${organization}`;
const caller = "reader";
const account = "acc_pool_failure_000";
const provider = "prv_pool_failure";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of [
    'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
    'create table "user" (id text primary key, name text, email text)',
    "create table organization (id text primary key, metadata text)",
    "create table executor_apps (id text primary key, owner text, active_deployment text)",
    "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
    "create table hosted_app_groups (app_id text, group_id text)",
    "create table hosted_group_members (group_id text, member_id text)",
    "create table hosted_model_bindings (app_id text, authorizer text, pool_id text, subject text)",
    "create table executor_deployments (id text primary key, requirements json)",
    "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text, audience text default 'everyone', creator_id text default 'owner', revision text default 'fixture-revision')",
    "create table hosted_app_account_links (app text, requirement text, subject text, account text, created_at timestamptz, linked_by text default 'owner')",
    "create table hosted_account_groups (account_id text, group_id text)",
    "create table executor_accounts (id text primary key, owner text, provider text, method text, credential_generation integer, encrypted_credentials bytea)",
    "create table executor_account_acquisitions (account text primary key, owner text, provider text, method text, generation integer, driver text, driver_revision text, revision text, removal jsonb, mirror_ready boolean, mirror_reference bytea)",
  ])
    yield* sql.unsafe(statement);
  yield* sql`insert into member values ('m-owner', ${organization}, 'owner', 'owner'), ('m-reader', ${organization}, ${caller}, 'admin')`;
  yield* sql`insert into "user" values ('owner', 'Owner', 'owner@example.invalid'), (${caller}, 'Reader', 'reader@example.invalid')`;
  yield* sql`insert into organization values (${organization}, ${JSON.stringify({ basaltPools: { fixture: { app, membership: "executor-links-v1" } } })})`;
  yield* sql`insert into executor_apps values (${app}, ${owner}, 'dpl_pool_failure')`;
  yield* sql`insert into hosted_app_access values (${app}, ${organization}, 'owner', 'everyone', 'revision-one')`;
  yield* sql`insert into executor_deployments values ('dpl_pool_failure', ${JSON.stringify({ accounts: { models: { scope: "app", provider } } })})`;
  yield* sql`insert into executor_accounts values (${account},${owner},${provider},'key',1,decode('01','hex'))`;
  yield* sql`insert into executor_account_acquisitions values (${account},${owner},${provider},'key',1,'basalt-home','driver-one','binding-one',null,true,null)`;
  yield* sql`insert into hosted_account_access (account_id, organization_id, kind, personal_user_id) values (${account},${organization},'shared',null)`;
  yield* sql`insert into hosted_app_account_links (app, requirement, subject, account, created_at) values (${app},'models',null,${account},now())`;
  yield* migrateContributedDepartures;
  registerContributedAccountSchema(sql);
});

/** The transaction and acquisition capabilities these reads use. */
const executor = (sql: SqlClient.SqlClient) => ({
  [sdk.StorageHost]: { transaction: sql.withTransaction },
  [sdk.AccountAcquisitionHost]: {
    source: () =>
      Effect.gen(function* () {
        const binding = sdk.AccountAcquisitionBinding.make({
          account: sdk.AccountId.make(account),
          owner: sdk.OwnerId.make(owner),
          provider: sdk.ProviderId.make(provider),
          method: "key",
          generation: 1,
          driver: "basalt-home",
          driverRevision: "driver-one",
          revision: "binding-one",
          removal: null,
        });
        return {
          binding,
          source: { kind: "driver", id: "basalt-home", version: "driver-one" },
          hostReference: Redacted.make("fixture-reference"),
          current: Effect.succeed(binding),
        };
      }),
  },
});

const bounds = { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" };

test("the real series and summary reads report the pool's 5xx answers, never its refusals", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // These routes use only the transaction and acquisition capabilities above.
      const hosted = executor(sql) as unknown as sdk.Executor;
      const version = sdk.VersionId.make("dpl_pool_failure");
      const authorize = Effect.succeed({
        app: { id: app, activeVersion: version },
        access: {
          organization,
          owner: sdk.OwnerId.make(owner),
          role: "admin" as const,
          userId: caller,
        },
      });
      // The pool's answer, served through the host's fetch service.
      const read = (route: "series" | "summary", status: number, error: string) => {
        const answer = async () =>
          Response.json({ error, message: "private backend detail" }, { status });
        const effect =
          route === "series" ? poolAppUsage(authorize) : poolAppUsageSummary(authorize);
        const input = route === "series" ? { ...bounds, bucket: "day", by: [] } : bounds;
        return underSentry(
          effect.pipe(
            Effect.provideService(HostedExecutor, Effect.succeed(hosted)),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`https://app.example.invalid/_executor/api/pool-usage/${route}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ version, input }),
                }),
              ),
            ),
            Effect.provideService(GroupDatabase, Effect.succeed(sql)),
            Effect.provideService(CurrentUserId, caller),
            Effect.provideService(CurrentOrganization, {
              organization,
              owner: sdk.OwnerId.make(owner),
              role: "admin",
            }),
            Effect.provideService(PoolUsageBackend, {
              origin: "https://pool.example.invalid",
              key: Redacted.make("ab".repeat(32)),
            }),
            Effect.provideService(FetchHttpClient.Fetch, answer),
          ),
        );
      };
      const tagsOf = (events: readonly { tags?: Readonly<Record<string, unknown>> }[]) =>
        events.map((event) => event.tags);

      for (let attempt = 0; attempt < 2; attempt++) {
        const timeout = yield* read("series", 504, "history_timeout");
        assert.equal(timeout.result.status, 504);
        assert.deepEqual(responseBody(timeout.result), { _tag: "UiFailed", reason: "timeout" });
        assert.deepEqual(tagsOf(timeout.events), [
          { [routeTag]: "pool-usage/series", [refusalTag]: "history_timeout" },
        ]);
        assert.equal(timeout.events[0]?.exception?.values?.[0]?.type, "PoolUsageTimedOut");
      }
      const unavailable = yield* read("series", 503, "backend_unavailable");
      assert.equal(unavailable.result.status, 503);
      assert.deepEqual(tagsOf(unavailable.events), [
        { [routeTag]: "pool-usage/series", [refusalTag]: "backend_unavailable" },
      ]);
      const invalid = yield* read("series", 400, "invalid_query");
      assert.equal(invalid.result.status, 503);
      assert.deepEqual(responseBody(invalid.result), { _tag: "UiFailed", reason: "unavailable" });
      assert.deepEqual(invalid.events, []);

      const tooLarge = [
        yield* read("summary", 503, "history_too_large"),
        yield* read("summary", 503, "history_too_large"),
      ];
      for (const load of tooLarge) {
        assert.equal(load.result.status, 503);
        assert.deepEqual(responseBody(load.result), { _tag: "UiFailed", reason: "unavailable" });
      }
      assert.deepEqual(
        tooLarge.flatMap((load) => tagsOf(load.events)),
        [{ [routeTag]: "pool-usage/summary", [refusalTag]: "history_too_large" }],
      );
      for (let attempt = 0; attempt < 2; attempt++)
        assert.deepEqual(tagsOf((yield* read("summary", 503, "backend_unavailable")).events), [
          { [routeTag]: "pool-usage/summary", [refusalTag]: "backend_unavailable" },
        ]);
      for (const load of [...tooLarge, unavailable, invalid])
        assert.equal(JSON.stringify(load.events).includes("private backend detail"), false);
    }).pipe(Effect.scoped, Effect.provide(pgliteLayer())),
  );
});
