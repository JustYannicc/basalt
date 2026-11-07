// Frozen account-link projection. Keep its rules unchanged while comparing returned rows.
import { Effect, Schema } from "effect";
import {
  StorageError,
  type Account,
  type AccountScope,
  type AppId,
  type Executor,
  type OwnerId,
} from "@executor-js/sdk/core";
import type { AppAccountLink } from "../../.upstream/apps/hosted/server/src/contracts/app-accounts.ts";
import {
  CurrentUserId,
  CurrentOrganization,
  HostedExecutor,
} from "./provider-destinations-modules.ts";
import { OrganizationForbidden } from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
const load = (path: string) =>
  import(
    new URL(`../../.upstream/apps/hosted/server/src/implementation/${path}.ts`, import.meta.url)
      .href
  );
const { AccountListReads } = (await load(
  "account-list-reads",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-list-reads.ts");
const { AccountLinkRecord: LinkRecord } = (await load(
  "account-list-links",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-list-links.ts");
const { canReconnectAccount } = (await load(
  "account-reconnect",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-reconnect.ts");
const { visibleObservationHealth } = (await load(
  "account-observation-policy",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-observation-policy.ts");
const { identityAccounts, redactAccountHealth, visibleAccountStatuses } = (await load(
  "account-identity",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-identity.ts");
const { currentOwner, usableApp } = (await load(
  "access",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/access.ts");
const { callerLinkedAccounts } = (await load(
  "app-accounts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/app-accounts.ts");
const { hostManagedAccounts } = (await load(
  "host-managed-accounts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/host-managed-accounts.ts");
const { acquiredAccount, linkedAccountSignIn } = (await load(
  "account-sign-in",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-sign-in.ts");
const { policyDatabase, requireCurrentAppAccess } = (await load(
  "resource-policy",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/resource-policy.ts");
const { registeredPool } = (await load(
  "provider-account-policy",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/provider-account-policy.ts");
/** The listed accounts the host manages in the caller's organization. */
const managedAmong = (executor: Executor, accounts: readonly Account[]) =>
  Effect.gen(function* () {
    const { organization } = yield* CurrentOrganization;
    return yield* hostManagedAccounts(executor, yield* policyDatabase, organization, accounts);
  });

const caller = Effect.gen(function* () {
  const user = yield* CurrentUserId;
  if (user === undefined) return yield* new OrganizationForbidden();
  return user;
});

type LinkRecord = typeof LinkRecord.Type;

/**
 * Links with each account, its sign-in and its checks by this app, in the records' order. A link
 * whose account no longer exists, or belongs to another owner, is left out. Ordinary app links
 * show upstream identity only to app editors; contributed links also permit holders and managers.
 */
const linkViews = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  records: ReadonlyArray<LinkRecord>,
  identity: boolean,
  scope: AccountScope,
  savedAccounts?: readonly Account[],
) =>
  Effect.gen(function* () {
    if (records.length === 0) return [];
    const reads = yield* AccountListReads;
    const target =
      reads?.owner === owner
        ? (reads.apps.get(app) ?? (yield* executor.apps.get({ owner, app })))
        : yield* executor.apps.get({ owner, app });
    const accounts = new Map(
      (savedAccounts ?? (yield* executor.accounts.list({ owner }))).map((account) => [
        account.id as string,
        account,
      ]),
    );
    const present = records.flatMap((record) => {
      const account = accounts.get(record.account);
      return account === undefined ? [] : [{ record, account }];
    });
    const managed = yield* managedAmong(
      executor,
      present.map(({ account }) => account),
    );
    const user = yield* CurrentUserId;
    const visible = yield* identityAccounts(present.map(({ account }) => account.id));
    const presentIds = new Set(present.map(({ account }) => account.id));
    const retained =
      reads?.owner === owner
        ? reads.snapshot.health.map((health) => ({
            ...health,
            apps: health.apps.filter(
              (entry) => entry.app === app && presentIds.has(health.account),
            ),
          }))
        : yield* executor.accounts.listHealth({
            owner,
            links: present.map(({ account }) => ({ app, account: account.id })),
          });
    const health = new Map(
      (yield* Effect.forEach(retained, visibleObservationHealth)).map((entry) => [
        entry.account,
        entry,
      ]),
    );
    const scopes = new Map(
      yield* Effect.forEach(present, ({ account }) =>
        acquiredAccount(executor, owner, account.id).pipe(
          Effect.map((acquired) => [account.id, acquired ? "app" : "saved"] as const),
        ),
      ),
    );
    const views = yield* Effect.forEach(
      present,
      ({ record, account }) => {
        const checks = health.get(account.id);
        return Effect.all([
          linkedAccountSignIn(executor, owner, account.id),
          canReconnectAccount(executor, owner, target, scope, record.requirement, account),
        ]).pipe(
          Effect.map(([state, canReconnect]): AppAccountLink[] => [
            {
              requirement: record.requirement,
              account,
              createdAt: record.createdAt,
              signIn: state,
              canReconnect,
              ...(managed.has(account.id) ? { hostManaged: true as const } : {}),
              linkedBy: { id: record.linkedBy, name: record.linkedByName },
              canRemove: identity || (record.contributed && record.linkedBy === user),
              credentialScope: scopes.get(account.id) ?? "saved",
              ...(checks === undefined
                ? {}
                : {
                    health:
                      identity || (record.contributed && visible.has(account.id))
                        ? checks
                        : redactAccountHealth(checks),
                  }),
            },
          ]),
          // The account was removed since it was listed.
          Effect.catchTag("AccountNotFound", () => Effect.succeed([])),
        );
      },
      { concurrency: 8 },
    );
    const pool = yield* registeredPool(app);
    return yield* visibleAccountStatuses(
      views.flat().map((view) => (pool ? { ...view, canReconnect: false } : view)),
      identity ? [app] : [],
    );
  });

/** The app's links in one scope, oldest first per requirement, optionally of one requirement. */
const linkRecords = (app: AppId, subject: string | null, requirement?: string) =>
  Effect.gen(function* () {
    const reads = yield* AccountListReads;
    if (reads !== undefined && reads.apps.has(app))
      return reads.records.filter(
        (record) =>
          record.app === app &&
          record.subject === subject &&
          (requirement === undefined || record.requirement === requirement),
      );
    const sql = yield* policyDatabase;
    return yield* sql`select l.requirement, l.account, l.created_at as "createdAt",
        l.linked_by as "linkedBy", u.name as "linkedByName",
        coalesce(d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'scope' = 'app'
          and d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'contributed' = 'true', false) as contributed
      from hosted_app_account_links l left join "user" u on u.id = l.linked_by
      join executor_apps a on a.id = l.app
      left join executor_deployments d on d.id = a.active_deployment
      where l.app = ${app}
        and ${subject === null ? sql`l.subject is null` : sql`l.subject = ${subject}`}
        and ${requirement === undefined ? sql`true` : sql`l.requirement = ${requirement}`}
      order by l.requirement, l.created_at, l.account`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LinkRecord))),
      Effect.mapError(() => new StorageError()),
    );
  });

/**
 * The caller's user links to an app whose accounts they may still use and their grant permits,
 * oldest first per requirement.
 */
const userLinkRecords = (app: AppId, requirement?: string) =>
  Effect.gen(function* () {
    const subject = yield* caller;
    const usable = new Set(
      (yield* callerLinkedAccounts([app])).map((link) => `${link.requirement}\u0000${link.id}`),
    );
    return (yield* linkRecords(app, subject, requirement)).filter((record) =>
      usable.has(`${record.requirement}\u0000${record.account}`),
    );
  });

/** Shared native link read for app Accounts and the saved-account projection. */
export const oldListAppAccountLinks = (
  app: AppId,
  scope: AccountScope,
  savedAccounts?: readonly Account[],
) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const reads = yield* AccountListReads;
    if (scope === "user") {
      if (reads?.owner === owner && reads.apps.has(app)) yield* requireCurrentAppAccess(app, "use");
      else yield* usableApp(executor, owner, app);
      return yield* linkViews(
        executor,
        owner,
        app,
        yield* userLinkRecords(app),
        true,
        scope,
        savedAccounts,
      );
    }
    const { access } = yield* requireCurrentAppAccess(app, "read");
    if (!(reads?.owner === owner && reads.apps.has(app))) yield* executor.apps.get({ owner, app });
    return yield* linkViews(
      executor,
      owner,
      app,
      yield* linkRecords(app, null),
      access.canManage,
      scope,
      savedAccounts,
    );
  });
