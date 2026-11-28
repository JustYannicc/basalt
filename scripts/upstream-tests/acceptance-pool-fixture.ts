import { Data, Effect } from "effect";
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

/** A stand-in for a product call's failure, tagged as every real one is. */
export class StandInFailure extends Data.TaggedError("StandInFailure")<{
  readonly reason: string;
}> {}

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
 * same account and a repeated link or unlink changes nothing. Like the product, a disconnect
 * refuses an account still linked to an app and cannot retire one whose acquiring app is gone,
 * an app's removal takes its links with it, and a removed pool leaves its record as a marker. `failAfter` makes one call commit and then
 * fail, as a reply lost after the product wrote.
 */
export function fixtureProduct(options: { readonly failAfter?: Set<string> } = {}) {
  const state = {
    pools: [] as Array<AcceptanceState["pools"][number]>,
    apps: [] as Array<AcceptanceState["apps"][number]>,
    links: [] as Array<AcceptanceState["links"][number]>,
    accounts: [] as string[],
    access: [] as Array<AcceptanceState["access"][number]>,
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
      if (options.failAfter?.delete(name))
        return Effect.fail(new StandInFailure({ reason: `${name} reply lost` }));
      return Effect.succeed(value);
    });
  const addApp = (id: string, name: string) => {
    state.apps.push({ id, name });
    state.access.push({ app: id, audience: "private", creator: "acceptance", groups: 0 });
  };
  const product: AcceptanceProduct<never> = {
    state: Effect.sync(() => structuredClone(state)),
    providerName: "Custom endpoint",
    createPool: (name, requestId) =>
      Effect.suspend(() => {
        const existing = state.pools.find((pool) => pool.request === requestId && pool.live);
        if (existing) return after("createPool", existing.app);
        const app = `app_pool_${++serial}`;
        const token = `acc_token_${serial}`;
        state.pools.push({
          app,
          request: requestId,
          name,
          owner: "acceptance",
          primary: true,
          account: token,
          live: true,
        });
        addApp(app, name);
        state.accounts.push(token);
        state.links.push({ app, requirement: "pool", account: token });
        return after("createPool", app);
      }),
    installProvider: Effect.suspend(() => {
      const existing = state.apps.find((app) => app.name === "Custom endpoint");
      if (existing) return after("installProvider", existing.id);
      const app = `app_custom_${++serial}`;
      addApp(app, "Custom endpoint");
      return after("installProvider", app);
    }),
    createAccount: (input) =>
      Effect.suspend(() => {
        const id = `acc_${input.creation.toLowerCase()}`;
        if (!state.accounts.includes(id)) {
          accounts.push({ id, app: input.app, method: input.method, fields: { ...input.fields } });
          state.accounts.push(id);
        }
        return after("createAccount", id);
      }),
    link: (pool, account) =>
      Effect.suspend(() => {
        if (!state.links.some((link) => link.app === pool && link.account === account))
          state.links.push({ app: pool, requirement: "custom", account });
        return after("link", undefined);
      }),
    unlink: (pool, account) =>
      Effect.suspend(() => {
        state.links = state.links.filter(
          (link) => !(link.app === pool && link.account === account),
        );
        return after(`unlink`, undefined);
      }),
    disconnect: (account) =>
      Effect.suspend(() => {
        if (state.links.some((link) => link.account === account && link.requirement !== "pool"))
          return Effect.fail(new StandInFailure({ reason: "AccountLinkedToApp" }));
        // An account is retired through the app that acquired it; once that app is gone, it cannot be.
        const acquired = accounts.find((entry) => entry.id === account);
        if (acquired !== undefined && !state.apps.some((app) => app.id === acquired.app))
          return Effect.fail(new StandInFailure({ reason: "InteractiveRetirementFailed" }));
        state.links = state.links.filter((link) => link.account !== account);
        state.accounts = state.accounts.filter((id) => id !== account);
        return after("disconnect", undefined);
      }),
    removeApp: (app) =>
      Effect.suspend(() => {
        state.apps = state.apps.filter((entry) => entry.id !== app);
        state.access = state.access.filter((entry) => entry.app !== app);
        state.links = state.links.filter((link) => link.app !== app);
        state.pools = state.pools.map((pool) =>
          pool.app === app ? { ...pool, live: false } : pool,
        );
        return after("removeApp", undefined);
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
