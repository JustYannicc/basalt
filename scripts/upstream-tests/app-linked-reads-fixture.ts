import assert from "node:assert/strict";
import type { Account, AccountId } from "../../.upstream/packages/sdk/src/core.ts";
import { createHash } from "node:crypto";
import { Crypto, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { providerFixtureApps } from "./provider-destinations-apps.ts";
import {
  sdk,
  authorization,
  CurrentAuthorization,
  CurrentOrganization,
  CurrentUserId,
  GroupDatabase,
  HostedExecutor,
  resources,
  type Executor,
  type App,
} from "./provider-destinations-modules.ts";
const load = (path: string) => import(new URL(`../../.upstream/${path}`, import.meta.url).href);
export const links = (await load(
  "apps/hosted/server/src/implementation/app-account-links.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/app-account-links.ts");
const { AccountListReads } = (await load(
  "apps/hosted/server/src/implementation/account-list-reads.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-list-reads.ts");
const { readIdentityMetadata } = (await load(
  "apps/hosted/server/src/implementation/account-identity.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-identity.ts");
const { readAccountListLinks } = (await load(
  "apps/hosted/server/src/implementation/account-list-links.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-list-links.ts");
type Services = Effect.Services<ReturnType<typeof links.listAppAccountLinks>>;
export type Options = {
  snapshot?: boolean;
  manager?: boolean;
  editor?: boolean;
  empty?: boolean;
  count?: number;
  deletedDuringRead?: boolean;
  storageFailure?: boolean;
  inaccessible?: boolean;
};
export const fixture = <A, E>(
  run: (input: {
    app: App;
    reads: Record<string, number>;
    reset: () => void;
    saved: Account[];
  }) => Effect.Effect<A, E, Services>,
  options: Options = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) =>
          Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
      });
      const base = yield* providerFixtureApps(false).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const { organization, owner } = base;
      const provider = base.accounts.openai!.provider;
      const slot = base.accounts.openai!;
      const app = {
        ...base.app,
        requirements: {
          accounts: {
            plain: { ...slot, provider, scope: "app" as const, contributed: false },
            contribution: { ...slot, provider, scope: "app" as const, contributed: true },
            own: { ...slot, provider, scope: "user" as const },
          },
        },
      };
      const saved = Array.from({ length: options.count ?? 48 }, (_, i) => ({
        id: sdk.AccountId.make(`acc_${i}`),
        owner,
        provider,
        method: "apiKey",
        label: `Identity ${i}`,
        description: "",
        createdAt: new Date("2026-01-01"),
        identity: {
          id: sdk.AccountIdentityId.make(`aid_${i}`),
          owner,
          placement: owner,
          issuer: "fixture",
          name: `Identity ${i}`,
          label: `Identity ${i}`,
        },
      }));
      const reads: Record<string, number> = {};
      const count = (key: string, n = 1) => {
        reads[key] = (reads[key] ?? 0) + n;
      };
      const reset = () => {
        for (const key of Object.keys(reads)) delete reads[key];
      };
      for (const ddl of [
        "create table organization (id text primary key, metadata text)",
        'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
        'create table "user" (id text primary key, name text)',
        "create table executor_apps (id text primary key, owner text, active_deployment text)",
        "create table executor_deployments (id text primary key, requirements text)",
        "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
        "create table hosted_app_groups (app_id text, group_id text)",
        "create table hosted_group_members (group_id text, member_id text)",
        "create table hosted_groups (id text, organization_id text)",
        "create table hosted_account_groups (account_id text, group_id text)",
        "create table hosted_account_access (account_id text, organization_id text, creator_id text, kind text, personal_user_id text, audience text, revision text)",
        "create table hosted_app_account_links (app text, subject text, requirement text, account text, created_at timestamptz, linked_by text)",
        "create table executor_accounts (id text, owner text, provider text, label text, description text)",
        "create table executor_account_connections (owner text, state text)",
        "create table hosted_account_observation_access (account_id text, organization_id text, read_audience jsonb, refresh_audience jsonb, revision text)",
      ])
        yield* sql.unsafe(ddl);
      yield* sql`insert into organization values (${organization}, ${JSON.stringify({ executorKeyAccounts: { person: saved[0]!.id } })})`;
      yield* sql`insert into member values ('member-person', ${organization}, 'person', ${options.manager ? "admin" : "member"})`;
      yield* sql`insert into "user" values ('person', 'Person'), ('other', 'Other')`;
      yield* sql`insert into executor_apps values (${app.id}, ${owner}, 'deployment')`;
      yield* sql`insert into executor_deployments values ('deployment', ${JSON.stringify(app.requirements)})`;
      yield* sql`insert into hosted_app_access values (${app.id}, ${organization}, ${options.editor ? "person" : "other"}, ${options.inaccessible ? "private" : "everyone"}, 'revision-1')`;
      for (const [i, account] of saved.entries()) {
        yield* sql`insert into executor_accounts values (${account.id}, ${owner}, ${provider}, ${account.label}, '')`;
        yield* sql`insert into hosted_account_access values (${account.id}, ${organization}, ${i === 1 ? "person" : "other"}, 'shared', null, 'everyone', 'revision-1')`;
        yield* sql`insert into executor_account_connections values (${owner}, ${JSON.stringify({ status: "completed", account: { id: account.id }, interactive: { accountInfo: { displayName: account.label } } })})`;
      }
      const recordIds = ["acc_0", "acc_1", "acc_2", "acc_missing", "acc_foreign", "acc_1"];
      if (!options.empty)
        for (const subject of [null, "person"])
          for (const [i, id] of recordIds.entries())
            yield* sql`insert into hosted_app_account_links values (${app.id}, ${subject}, ${subject === null ? (i === 1 ? "contribution" : "plain") : "own"}, ${id}, ${new Date(1767225600000 + i)}, ${i % 2 ? "person" : "other"})`;
      const health = saved.map((account, i) => ({
        account: account.id,
        info: { displayName: account.label },
        infoCheckedAt: new Date("2026-01-01"),
        apps: [
          {
            app: app.id,
            checkable: true,
            check:
              i % 2
                ? {
                    status: "healthy" as const,
                    checkedAt: new Date("2026-01-01"),
                    current: true,
                    displayStatus: {
                      badges: [{ label: "Plan", tone: "neutral" as const }],
                      meters: [{ label: "Weekly", remaining: 75 }],
                      stats: [{ label: "Usage", value: "25%" }],
                    },
                  }
                : null,
          },
        ],
      }));
      const executor = {
        [sdk.AccountReadHost]: {
          listIds: ({ owner: requestedOwner, ids }: { owner: string; ids: readonly AccountId[] }) =>
            Effect.suspend(() => {
              assert.equal(requestedOwner, owner);
              return options.storageFailure
                ? Effect.fail(new sdk.StorageError())
                : Effect.sync(() => {
                    const selected = saved.filter((account) => ids.includes(account.id));
                    count("accountList");
                    count("accountRows", selected.length);
                    return selected;
                  });
            }),
        },
        apps: {
          get: () =>
            Effect.sync(() => {
              return app;
            }),
        },
        accounts: {
          list: () =>
            executor[sdk.AccountReadHost].listIds({
              owner,
              ids: saved.map((account) => account.id),
            }),
          get: ({ account, owner: requestedOwner }: { account: AccountId; owner: string }) =>
            Effect.gen(function* () {
              count("accountGet");
              if (options.storageFailure) return yield* new sdk.StorageError();
              const foreign = {
                ...saved[0]!,
                id: sdk.AccountId.make("acc_foreign"),
                owner: sdk.OwnerId.make("organization:foreign"),
              };
              const found = [...saved, foreign].find(
                (a) => a.id === account && a.owner === requestedOwner,
              );
              if (!found) return yield* new sdk.AccountNotFound({ account });
              count("accountRows");
              return found;
            }),
          providers: () =>
            Effect.sync(() => {
              return [];
            }),
          listHealth: ({ links: requested }: { links: { account: AccountId }[] }) =>
            Effect.sync(() => {
              const selected = health.filter((h) => requested.some((l) => l.account === h.account));
              count("healthRows", selected.length);
              return selected;
            }),
          signIn: ({ account }: { account: AccountId }) =>
            options.deletedDuringRead && account === "acc_2"
              ? Effect.fail(new sdk.AccountNotFound({ account }))
              : Effect.sync(() => {
                  return account === "acc_2"
                    ? { state: "reconnect" as const }
                    : { state: "saved" as const, reconnectAt: null };
                }),
        },
        [sdk.InteractiveHost]: {
          binding: ({ account }: { account: AccountId }) =>
            Effect.sync(() => {
              return account === "acc_2" ? { app: app.id } : undefined;
            }),
        },
        [sdk.StorageHost]: { read: (_tables: string[], effect: Effect.Effect<unknown>) => effect },
      } as unknown as Executor;
      const operation = Effect.gen(function* () {
        let snapshot: typeof AccountListReads.Service;
        if (options.snapshot) {
          const actor = yield* resources.currentResourceAuthority;
          const ids = saved.map((a) => a.id);
          const records = yield* readAccountListLinks([app.id]);
          snapshot = {
            owner,
            actor,
            snapshot: {
              accounts: saved,
              providers: new Map(),
              health,
              acquired: new Set([saved[2]!.id]),
              signIns: new Map(
                saved.map((a, i) => [
                  a.id,
                  i === 2
                    ? { state: "reconnect" as const }
                    : { state: "saved" as const, reconnectAt: null },
                ]),
              ),
            },
            apps: new Map([[app.id, app]]),
            appAccesses: new Map(
              (yield* resources.applicationAccesses([app.id], actor)).map((a) => [a.app, a]),
            ),
            accountAccesses: new Map(
              (yield* resources.accountAccesses(ids, actor)).map((a) => [a.account, a]),
            ),
            records,
            userLinks: saved.slice(0, 3).map((a) => ({
              app: app.id,
              requirement: "own",
              id: a.id,
              provider,
              label: a.label,
              description: "",
            })),
            managed: new Set([saved[0]!.id]),
            pools: new Set(),
            identity: yield* readIdentityMetadata(ids),
            observations: new Map(
              ids.map((id) => [id, options.manager === true || id === "acc_1"]),
            ),
          } satisfies NonNullable<typeof AccountListReads.Service>;
        }
        reset();
        return yield* run({ app, reads, reset, saved }).pipe(
          Effect.provideService(AccountListReads, snapshot),
        );
      }).pipe(
        Effect.provideService(GroupDatabase, Effect.succeed(sql)),
        Effect.provideService(CurrentOrganization, {
          organization,
          owner,
          role: options.manager ? "admin" : "member",
        }),
        Effect.provideService(CurrentUserId, "person"),
        Effect.provideService(CurrentAuthorization, authorization.fullAuthority),
        Effect.provideService(HostedExecutor, Effect.succeed(executor)),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      return yield* operation;
    }),
  ).pipe(Effect.provide(pgliteLayer()));
