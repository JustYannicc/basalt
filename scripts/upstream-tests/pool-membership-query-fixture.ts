import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import type { NativePoolAccount } from "../../.upstream/apps/hosted/server/src/implementation/pool-membership.ts";
import { app, organization } from "./org-lock-postgres-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
export const [sdk, membership] = await Promise.all([
  load("packages/sdk/src/core.ts"),
  load("apps/hosted/server/src/implementation/pool-membership.ts"),
]);
export const owner = `organization:${organization}`;
export const provider = "prv_membership_query";
export const home = "acc_membership_000";

export const seed = ({
  requirements = { accounts: { models: { scope: "app", provider } } },
  accounts = 32,
  hosted = false,
}: {
  readonly requirements?: unknown;
  readonly accounts?: number;
  readonly hosted?: boolean;
} = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of [
      "alter table executor_apps add column active_deployment text",
      "create table executor_deployments (id text primary key, requirements json)",
      "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text)",
      "create table hosted_app_account_links (app text, requirement text, subject text, account text, created_at timestamptz)",
      "create table executor_accounts (id text primary key, owner text, provider text, method text, credential_generation integer, encrypted_credentials bytea)",
      "create table executor_account_acquisitions (account text primary key, owner text, provider text, method text, generation integer, driver text, driver_revision text, revision text, removal jsonb, mirror_ready boolean, mirror_reference bytea)",
    ])
      yield* sql.unsafe(statement);
    yield* sql`update organization set metadata=${JSON.stringify({ basaltPools: { fixture: { app, membership: "executor-links-v1" } } })} where id=${organization}`;
    yield* sql`insert into executor_deployments values ('dpl_membership_query', ${JSON.stringify(requirements)})`;
    yield* sql`update executor_apps set active_deployment='dpl_membership_query' where id=${app}`;
    for (let index = 0; index < accounts; index++) {
      const id = `acc_membership_${String(index).padStart(3, "0")}`;
      yield* sql`insert into executor_accounts values (${id},${owner},${provider},'key',1,decode('01','hex'))`;
      yield* sql`insert into executor_account_acquisitions values (${id},${owner},${provider},'key',1,'basalt-home','driver-one','binding-one',null,true,null)`;
      yield* sql`insert into hosted_account_access values (${id},${organization},'shared',null)`;
      yield* sql`insert into hosted_app_account_links values (${app},'models',null,${id},now())`;
    }
    if (hosted) {
      yield* sql`alter table hosted_account_access add column audience text default 'everyone'`;
      yield* sql`alter table hosted_app_account_links add column linked_by text default 'owner'`;
      yield* sql`create table hosted_account_groups (account_id text, group_id text)`;
      const { migrateContributedDepartures } = yield* Effect.promise(
        () =>
          import("../../.upstream/apps/hosted/server/src/implementation/contributed-departure-schema.ts"),
      );
      yield* migrateContributedDepartures;
      const { registerContributedAccountSchema } = yield* Effect.promise(
        () => import("../../.upstream/apps/hosted/server/src/implementation/app-link-schema.ts"),
      );
      registerContributedAccountSchema(sql);
    }
  });

export const runtime = (sql: SqlClient.SqlClient, hold = Effect.void) => {
  let reads = 0;
  const executor = {
    [sdk.StorageHost]: { transaction: sql.withTransaction },
    [sdk.AccountAcquisitionHost]: {
      source: ({ account }: { account: string }) =>
        Effect.gen(function* () {
          reads++;
          const [row] = yield* sql<{
            revision: string;
            generation: number;
          }>`select revision,generation from executor_account_acquisitions where account=${account}`;
          assert.ok(row);
          const binding = {
            account: sdk.AccountId.make(account),
            owner: sdk.OwnerId.make(owner),
            provider: sdk.ProviderId.make(provider),
            method: "key",
            generation: row.generation,
            driver: "basalt-home",
            driverRevision: "driver-one",
            revision: row.revision,
            removal: null,
          };
          return {
            binding,
            source: { kind: "driver", id: "basalt-home", version: "driver-one" },
            hostReference: Redacted.make(`fixture-reference-${row.revision}`),
            current: hold.pipe(Effect.as(binding)),
          };
        }),
    },
  };
  return { executor, reads: () => reads };
};

export const nativeRead = (executor: ReturnType<typeof runtime>["executor"]) =>
  membership.nativePoolMembership(organization, app, executor) as Effect.Effect<
    { accounts: readonly (typeof NativePoolAccount.Type)[] },
    unknown,
    SqlClient.SqlClient
  >;
