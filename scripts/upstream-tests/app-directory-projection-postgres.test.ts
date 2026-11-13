import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { CurrentTransformer } from "effect/sql/Statement";
import { appDirectoryPostgres } from "./app-directory-postgres-fixture.ts";
import {
  authorization,
  CurrentAuthorization,
  CurrentOrganization,
  CurrentUserId,
  GroupDatabase,
  HostedExecutor,
  HostedCatalog,
  OrganizationId,
  sdk,
} from "./provider-destinations-modules.ts";
import { HostedAppRuntime } from "../../.upstream/apps/hosted/server/src/contracts/app-ui.ts";
import {
  resourceDirectory,
  savedAccountDirectory,
} from "../../.upstream/apps/hosted/server/src/implementation/resource-directory.ts";
import { inventory } from "../../.upstream/apps/hosted/server/src/implementation/organization.ts";
import { ResourceDirectory } from "../../.upstream/apps/hosted/server/src/contracts/resource-access.ts";
import { AppScreenRecord } from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { OrganizationDefaults } from "../../.upstream/apps/hosted/server/src/contracts/organization-defaults.ts";
import { ScheduleWakeup } from "../../.upstream/apps/hosted/server/src/contracts/schedules.ts";

const organization = OrganizationId.make("directory-fixture");
const owner = sdk.OwnerId.make(`organization:${organization}`);
const app = sdk.AppId.make("app_directory");
const hidden = sdk.AppId.make("app_hidden");
const user = "directory-reader";
const renderedApps = (apps: unknown) =>
  execFileSync("bun", ["scripts/upstream-tests/app-directory-renderer.mjs"], {
    input: JSON.stringify({ apps }),
    encoding: "utf8",
  });
const requirements = {
  icons: [
    { src: "https://example.invalid/icon.svg", theme: "light" },
    { src: "https://example.invalid/icon-dark.svg", theme: "dark" },
  ],
  accounts: Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `slot${index}`,
      {
        scope: "user",
        provider: `prv_${index}`,
        cardinality: "one",
        contributed: false,
        definition: {
          name: `Service ${index}`,
          auth: {
            key: {
              type: "secrets",
              label: "API key",
              fields: {
                type: "object",
                description: "Synthetic provider instructions. ".repeat(140),
              },
            },
          },
        },
      },
    ]),
  ),
};

test("hosted directory and inventory keep complete display data without repeated requirement bytes", async () => {
  await appDirectoryPostgres(({ executor: initial, restart, sql, bytes }) =>
    Effect.gen(function* () {
      let executor = initial;
      yield* Schema.decodeUnknownEffect(sdk.AppRequirements)(requirements);
      for (const statement of [
        'create table "user" (id text primary key, name text, email text)',
        'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
        "create table organization (id text primary key, metadata text)",
        "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
        "create table hosted_app_groups (app_id text, group_id text)",
        "create table hosted_group_members (group_id text, member_id text)",
        "create table hosted_account_access (account_id text primary key, organization_id text, creator_id text, kind text, personal_user_id text, audience text, revision text)",
        "create table hosted_account_groups (account_id text, group_id text)",
        "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
      ])
        yield* sql.unsafe(statement);
      yield* sql`insert into organization values (${organization}, '{}')`;
      yield* sql`insert into "user" values (${user}, 'Reader', 'reader@example.invalid')`;
      yield* sql`insert into member values ('member-reader', ${organization}, ${user}, 'member')`;
      for (const id of [app, hidden]) {
        yield* sql`insert into executor_deployments (id,code,owner,build,requirements,created_at,source_commit,file_count)
        values (${`dpl_${id}`},${`code_${id}`},${owner},'build_fixture',${JSON.stringify(requirements)},now(),null,1)`;
        yield* sql`insert into executor_apps (id,code,repository,owner,name,slug,active_deployment,copied_from,created_at)
        values (${id},${`code_${id}`},null,${owner},${id},${id.replaceAll("_", "-")},${`dpl_${id}`},null,now())`;
        yield* sql`insert into hosted_app_access values (${id},${organization},'other',${id === hidden ? "private" : "everyone"},'revision-one')`;
      }
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(HostedExecutor, Effect.succeed(executor)),
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(CurrentUserId, user),
          Effect.provideService(CurrentOrganization, { organization, owner, role: "member" }),
          Effect.provideService(
            CurrentAuthorization,
            authorization.selectedAuthority(["read", "discover"], {
              kind: "tools",
              apps: [app, hidden].map((app) => ({ app, tools: { kind: "all" } })),
            }),
          ),
          Effect.provideService(HostedAppRuntime, {
            asset: () => Effect.die("Unexpected asset read"),
          }),
          Effect.provideService(HostedCatalog, {
            list: Effect.succeed([]),
            prepare: () => Effect.die("Unexpected catalog install"),
            custom: () => Effect.die("Unexpected custom install"),
          }),
          Effect.provideService(OrganizationDefaults, () => Effect.die("Unexpected setup write")),
          Effect.provideService(ScheduleWakeup, Effect.die("Unexpected schedule write")),
        );
      const coldBefore = bytes();
      const cold = yield* run(resourceDirectory());
      const coldBytes = bytes() - coldBefore;
      assert.deepEqual(
        cold.apps.map(({ app }) => app.id),
        [app],
      );
      assert.deepEqual(
        cold.apps[0]?.app.requirements.accounts.slot0?.definition,
        requirements.accounts.slot0?.definition,
      );
      yield* Schema.encodeEffect(ResourceDirectory)(cold);
      executor = yield* restart;
      const before = bytes();
      const warm = yield* run(resourceDirectory());
      const warmBytes = bytes() - before;
      assert.deepEqual(warm, cold);
      const rendered = renderedApps(warm.apps.map(({ app }) => app));
      assert.match(rendered, /app_directory/);
      assert.match(rendered, /Needs account/);
      assert.doesNotMatch(rendered, /app_hidden/);
      assert.equal(rendered, renderedApps(cold.apps.map(({ app }) => app)));
      const inventoryBefore = bytes();
      const listed = yield* run(inventory(owner));
      const inventoryBytes = bytes() - inventoryBefore;
      assert.deepEqual(
        listed.apps.map((app) => app.id),
        [app],
      );
      yield* Schema.encodeEffect(Schema.Array(AppScreenRecord))(listed.apps);
      assert.deepEqual(listed.apps[0]?.requirements, cold.apps[0]?.app.requirements);
      assert.equal(renderedApps(listed.apps), rendered);
      assert.deepEqual(yield* run(savedAccountDirectory()), []);
      console.log(
        JSON.stringify({
          coldBytes,
          warmBytes,
          inventoryBytes,
          visibleApps: warm.apps.length,
          requirements: Object.keys(warm.apps[0]!.app.requirements.accounts).length,
        }),
      );
      assert.ok(warmBytes < 16_384, `Warm resource read returned ${warmBytes} PostgreSQL bytes`);
      assert.ok(
        inventoryBytes < 16_384,
        `Warm inventory read returned ${inventoryBytes} PostgreSQL bytes`,
      );
      const all = yield* executor.apps.list({ owner });
      assert.deepEqual(
        all.map((app) => app.id),
        [app, hidden],
      );
      assert.deepEqual(all[0]?.requirements, warm.apps[0]?.app.requirements);
      assert.deepEqual(yield* executor[sdk.AppReadHost].list({ owner, ids: [] }), []);
      assert.deepEqual(
        yield* executor[sdk.AppReadHost].list({
          owner: sdk.OwnerId.make("organization:foreign"),
        }),
        [],
      );

      yield* sql`update hosted_app_access set audience='private',revision='revoked' where id=${app}`;
      assert.deepEqual((yield* run(resourceDirectory())).apps, []);
      assert.deepEqual((yield* run(inventory(owner))).apps, []);
      yield* sql`update hosted_app_access set audience='everyone',revision='restored' where id=${app}`;
      const changed = {
        ...requirements,
        accounts: {
          slot0: {
            ...requirements.accounts.slot0!,
            definition: { name: "Changed service", auth: {} },
          },
        },
      };
      yield* sql`insert into executor_deployments (id,code,owner,build,requirements,created_at,source_commit,file_count)
      values ('dpl_changed',${`code_${app}`},${owner},'build_changed',${JSON.stringify(changed)},now(),null,1)`;
      yield* sql`update executor_apps set active_deployment='dpl_changed',name='Renamed app',slug='renamed-app' where id=${app}`;
      const updated = yield* run(resourceDirectory());
      assert.equal(updated.apps[0]?.app.name, "Renamed app");
      assert.equal(updated.apps[0]?.app.activeVersion, "dpl_changed");
      assert.equal(
        updated.apps[0]?.app.requirements.accounts.slot0?.definition.name,
        "Changed service",
      );
      yield* sql`update executor_apps set active_deployment=${`dpl_${app}`} where id=${app}`;
      assert.deepEqual(
        (yield* run(resourceDirectory())).apps[0]?.app.requirements,
        warm.apps[0]?.app.requirements,
      );

      const account = sdk.AccountId.make("acc_directory");
      yield* sql`insert into executor_providers (id,definition) values ('prv_0',${JSON.stringify(requirements.accounts.slot0!.definition)})`;
      yield* sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at)
      values (${account},${owner},'prv_0','key','Saved key',decode('01','hex'),now())`;
      yield* sql`insert into hosted_account_access values (${account},${organization},${user},'personal',${user},null,'account-one')`;
      yield* sql`insert into hosted_app_account_links values (${app},'slot0',${user},${account},${user},now())`;
      const saved = yield* run(savedAccountDirectory());
      assert.equal(saved.length, 1);
      assert.equal(saved[0]?.id, account);
      assert.equal(saved[0]?.bindings[0]?.app, app);
      assert.equal(saved[0]?.bindings[0]?.requirement, "slot0");
      assert.equal(saved[0]?.providerName, "Service 0");
    }),
  );
});

test("SDK display hydration batches cold versions and reuses them across request SDKs", async () => {
  await appDirectoryPostgres(({ executor, restart, sql }) =>
    Effect.gen(function* () {
      for (const id of [app, hidden]) {
        yield* sql`insert into executor_deployments (id,code,owner,build,requirements,created_at,source_commit,file_count)
        values (${`dpl_${id}`},${`code_${id}`},${owner},'build_fixture',${JSON.stringify(requirements)},now(),null,1)`;
        yield* sql`insert into executor_apps (id,code,repository,owner,name,slug,active_deployment,copied_from,created_at)
        values (${id},${`code_${id}`},null,${owner},${id},${id.replaceAll("_", "-")},${`dpl_${id}`},null,now())`;
      }
      const metadata = yield* executor[sdk.AppReadHost].list({ owner });
      const statements: string[] = [];
      const count = CurrentTransformer.of((statement) =>
        Effect.sync(() => {
          statements.push(statement.compile()[0]);
          return statement;
        }),
      );
      const cold = yield* executor[sdk.AppReadHost]
        .hydrate(metadata)
        .pipe(Effect.provideService(CurrentTransformer, count));
      assert.equal(cold.length, 2);
      assert.equal(statements.length, 1, "Cold declarations share one database read");
      statements.length = 0;
      const next = yield* restart;
      const fresh = yield* next[sdk.AppReadHost].list({ owner });
      const warm = yield* next[sdk.AppReadHost]
        .hydrate(fresh)
        .pipe(Effect.provideService(CurrentTransformer, count));
      assert.deepEqual(warm, cold);
      assert.equal(
        statements.length,
        0,
        "A new request SDK does not reload completed immutable declarations",
      );
    }),
  );
});
