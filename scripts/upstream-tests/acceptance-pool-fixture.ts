import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { migrateProvisioning } from "../../.upstream/apps/hosted/server/src/implementation/provisioning-schema.ts";
import {
  migrateProductionOps,
  migrateProductionOpsDatabaseIdentity,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/schema.ts";
import type {
  AcceptanceProduct,
  AcceptanceState,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/steps.ts";

/** Better Auth's columns the identity reads and writes, the real lifecycle triggers, and the welcome trigger. */
export const identitySchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of [
    `create table "user" (id text primary key, name text, email text unique, "emailVerified" boolean,
      image text, "createdAt" timestamptz, "updatedAt" timestamptz)`,
    `create table organization (id text primary key, name text, slug text unique, logo text,
      "createdAt" timestamptz, metadata text)`,
    `create table member (id text primary key, "organizationId" text references organization(id)
      on delete cascade, "userId" text references "user"(id) on delete cascade, role text, "createdAt" timestamptz)`,
    `create table account (id text primary key, "userId" text)`,
    `create table session (id text primary key, "userId" text)`,
    `create table apikey (id text primary key, "referenceId" text)`,
    `create table passkey (id text primary key, "userId" text)`,
    `create table invitation (id text primary key, "organizationId" text)`,
    `create table hosted_organization_removal (organization_id text primary key)`,
    `create table cloud_billing_seats (organization_id text primary key, seat_plan boolean not null default false,
      synced_count integer)`,
    // The product migration's welcome queue (apps/hosted/cloud/src/implementation/migrations.ts).
    `create table cloud_welcome_email (user_id text primary key references "user"(id) on delete cascade,
      status text not null default 'pending')`,
    `create or replace function cloud_queue_welcome_email() returns trigger as $$
      begin insert into cloud_welcome_email (user_id) values (NEW.id) on conflict do nothing; return NEW; end;
      $$ language plpgsql`,
    `create trigger cloud_welcome_email_created after insert on "user"
      for each row execute function cloud_queue_welcome_email()`,
    `create table private_hosted_data_steps (name text not null, run text not null, mode text not null,
      cursor text, pass integer not null default 0, completed_at timestamptz, primary key (name, run))`,
  ])
    yield* sql.unsafe(statement);
  yield* migrateProvisioning;
  return sql;
});

/** The identity's tables plus the production-ops receipts the runner writes. */
export const operationSchema = Effect.gen(function* () {
  const sql = yield* identitySchema;
  yield* migrateProductionOps;
  yield* migrateProductionOpsDatabaseIdentity;
  return sql;
});

/**
 * The product calls as the real paths behave on a repeat: the same request id returns the same
 * pool, the provider install reuses the organization's default, the same creation id returns the
 * same account and a repeated link changes nothing. `failAfter` makes one call commit and then
 * fail, as a reply lost after the product wrote.
 */
export function fixtureProduct(options: { readonly failAfter?: Set<string> } = {}) {
  const state = {
    pools: [] as Array<AcceptanceState["pools"][number]>,
    apps: [] as Array<AcceptanceState["apps"][number]>,
    links: [] as Array<AcceptanceState["links"][number]>,
  };
  const calls: string[] = [];
  const accounts: Array<{
    id: string;
    app: string;
    method: string;
    fields: Record<string, string>;
  }> = [];
  let serial = 0;
  const after = <A>(name: string, value: A) =>
    Effect.suspend(() => {
      calls.push(name);
      if (options.failAfter?.delete(name)) return Effect.fail(new Error(`${name} reply lost`));
      return Effect.succeed(value);
    });
  const product: AcceptanceProduct<never> = {
    state: Effect.sync(() => structuredClone(state)),
    providerName: "Custom endpoint",
    createPool: (name, requestId) =>
      Effect.suspend(() => {
        const existing = state.pools.find((pool) => pool.request === requestId);
        if (existing) return after("createPool", existing.app);
        const app = `app_pool_${++serial}`;
        state.pools.push({
          app,
          request: requestId,
          name,
          owner: "acceptance",
          primary: true,
          live: true,
        });
        state.apps.push({ id: app, name });
        state.links.push({ app, requirement: "pool", account: `acc_token_${serial}` });
        return after("createPool", app);
      }),
    installProvider: Effect.suspend(() => {
      const existing = state.apps.find((app) => app.name === "Custom endpoint");
      if (existing) return after("installProvider", existing.id);
      const app = `app_custom_${++serial}`;
      state.apps.push({ id: app, name: "Custom endpoint" });
      return after("installProvider", app);
    }),
    createAccount: (input) =>
      Effect.suspend(() => {
        const id = `acc_${input.creation.toLowerCase()}`;
        if (!accounts.some((account) => account.id === id))
          accounts.push({ id, app: input.app, method: input.method, fields: { ...input.fields } });
        return after("createAccount", id);
      }),
    link: (pool, account) =>
      Effect.suspend(() => {
        if (!state.links.some((link) => link.app === pool && link.account === account))
          state.links.push({ app: pool, requirement: "custom", account });
        return after("link", undefined);
      }),
    membership: (pool) =>
      Effect.sync(() => ({
        native: state.pools.some((entry) => entry.app === pool && entry.live),
        accounts: state.links
          .filter((link) => link.app === pool && link.requirement === "custom")
          .map((link) => link.account),
      })),
  };
  return { product, state, calls, accounts };
}
