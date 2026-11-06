import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

const root = new URL("../../.upstream/", import.meta.url);
const { hostedResourceLifecycle } = (await import(
  new URL("apps/hosted/server/src/implementation/resource-lifecycle.ts", root).href
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/resource-lifecycle.ts");
const { CurrentOrganization, OrganizationId } = (await import(
  new URL("apps/hosted/server/src/contracts/organization.ts", root).href
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/organization.ts");
const { CurrentUserId } = (await import(
  new URL("apps/hosted/server/src/contracts/auth.ts", root).href
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/auth.ts");
const { GroupDatabase } = (await import(
  new URL("apps/hosted/server/src/contracts/groups.ts", root).href
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/groups.ts");
const { visibleAccountStatuses } = (await import(
  new URL("apps/hosted/server/src/implementation/account-identity.ts", root).href
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-identity.ts");
const { Account, AccountHealth } = (await import(
  new URL("packages/sdk/src/contracts/account.ts", root).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/account.ts");
const { ProviderDefinition } = (await import(
  new URL("packages/sdk/src/contracts/provider.ts", root).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/provider.ts");
const { OwnerId } = (await import(
  new URL("packages/sdk/src/contracts/shared.ts", root).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/shared.ts");

export const organization = OrganizationId.make("org_visibility");
export const owner = OwnerId.make(`organization:${organization}`);
export const definition = Schema.decodeUnknownSync(ProviderDefinition)({
  name: "Example",
  auth: {
    key: {
      type: "secrets",
      label: "Key",
      fields: { type: "object", properties: {}, additionalProperties: false },
    },
  },
});

/** Real hosted policies over an isolated database; SDK metadata is supplied without credentials. */
export const visibilityFixture = (verified: boolean, label = "Default 2") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of [
      'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
      "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text, creator_id text, audience text, revision text)",
      "create table hosted_account_groups (account_id text, group_id text)",
      "create table hosted_group_members (group_id text, member_id text)",
      "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
      "create table hosted_app_groups (app_id text, group_id text)",
      "create table hosted_app_account_links (app text, account text, subject text)",
      "create table executor_account_connections (owner text, state jsonb)",
    ])
      yield* sql.unsafe(statement);
    yield* sql`insert into member values ('m_owner', ${organization}, 'owner', 'owner'), ('m_member', ${organization}, 'member', 'member')`;
    yield* sql`insert into hosted_account_access values ('acc_visibility', ${organization}, 'shared', null, 'owner', 'everyone', 'rev_account')`;
    yield* sql`insert into hosted_app_access values ('app_visibility', ${organization}, 'owner', 'everyone', 'rev_app')`;
    yield* sql`insert into hosted_app_account_links values ('app_visibility', 'acc_visibility', null)`;
    yield* sql`insert into executor_account_connections values (${owner}, ${JSON.stringify({ status: "completed", account: { id: "acc_visibility" }, interactive: { accountInfo: { email: "owner@company.test" } } })})`;
    const account = Schema.decodeUnknownSync(Account)({
      id: "acc_visibility",
      owner,
      provider: "prv_visibility",
      method: "key",
      label,
      description: null,
      createdAt: new Date(0),
      ...(verified
        ? {
            identity: {
              id: "aid_visibility",
              issuer: "https://example.test",
              name: "Example",
              label: "Verified Owner",
            },
          }
        : {}),
    });
    const health = Schema.decodeUnknownSync(AccountHealth)({
      account: account.id,
      info: { email: "owner@company.test" },
      infoCheckedAt: new Date(0),
      apps: [],
    });
    const lifecycle = yield* hostedResourceLifecycle.pipe(Effect.provide(NodeCrypto.layer));
    type Executor = Parameters<typeof lifecycle.attach>[0];
    const executor = {
      accounts: { get: () => Effect.succeed(account), health: () => Effect.succeed(health) },
    } as unknown as Executor;
    yield* lifecycle.attach(executor);
    const row = (actor: string) =>
      visibleAccountStatuses([{ account, health }]).pipe(
        Effect.provideService(CurrentUserId, actor),
        Effect.provideService(CurrentOrganization, {
          organization,
          owner,
          role: actor === "owner" ? "owner" : "member",
        }),
        Effect.provideService(GroupDatabase, Effect.succeed(sql)),
        Effect.map(([status]) => status!),
      );
    return { account, health, hooks: lifecycle.hooks, row };
  });
