import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  fixture,
  load,
  implementation,
  contracts,
  organization,
  secret,
} from "./pool-access-fixture.ts";
const { AppId } = await load("packages/sdk/src/core.ts");
const { AccessRevision } = await load(`${contracts}resource-access.ts`);
const { shareApp } = await load(`${implementation}resource-access.ts`);
const { hostedResourceLifecycle } = await load(`${implementation}resource-lifecycle.ts`);
const pool = Schema.decodeUnknownSync(AppId)("app_pool-fixture");
const share = (sql: any, kind: string, groups: string[] = []) =>
  Effect.gen(function* () {
    const [row] = yield* sql`select revision from hosted_app_access where id = ${pool}`;
    return yield* shareApp(
      pool,
      kind === "groups" ? { kind, groups } : { kind },
      Schema.decodeUnknownSync(AccessRevision)(row.revision),
    );
  });

test("shareApp sends signed post-write audiences inside its transaction; worker errors roll it back", async () => {
  await fixture(({ sql, changes, requestTransactions, fail, recover }) =>
    Effect.gen(function* () {
      yield* share(sql, "everyone");
      assert.deepEqual(changes[0].pools, [
        {
          pool,
          owner: "owner",
          organization,
          name: "Fixture pool",
          users: ["guest", "other", "owner"],
        },
      ]);
      assert.deepEqual(requestTransactions, [true]);
      yield* sql`insert into hosted_groups (id, organization_id, name) values ('g-fixture', ${organization}, 'Friends')`;
      yield* sql`insert into hosted_group_members values ('g-fixture', 'm-guest')`;
      yield* share(sql, "groups", ["g-fixture"]);
      assert.deepEqual(changes[1].pools[0].users, ["guest", "owner"]);
      const before = yield* sql`select * from hosted_app_access where id = ${pool}`;
      const groups = yield* sql`select * from hosted_app_groups`;
      fail();
      assert.equal((yield* Effect.exit(share(sql, "private")))._tag, "Failure");
      assert.deepEqual(yield* sql`select * from hosted_app_access where id = ${pool}`, before);
      assert.deepEqual(yield* sql`select * from hosted_app_groups`, groups);
      recover();
      yield* share(sql, "private");
      assert.deepEqual(changes.at(-1).pools[0].users, ["owner"]);
    }),
  );
});

test("member removal projects the audience without its membership and refuses a failed acknowledgement", async () => {
  const { organizationAccessHooks } = await load(
    "apps/hosted/cloud/src/implementation/access-hooks.ts",
  );
  await fixture(({ sql, hook, changes, fail }) =>
    Effect.gen(function* () {
      yield* sql`update hosted_app_access set audience = 'everyone' where id = ${pool}`;
      const callbacks = organizationAccessHooks({
        memberRemoving: (org: string, member: string) =>
          Effect.runPromise(
            hook
              .memberRemoving({ organization: org, member })
              .pipe(Effect.provideService(SqlClient, sql)),
          ),
        membersAdded: async () => {},
        userDeleting: async () => {},
      });
      const removal = () =>
        Effect.tryPromise(() =>
          callbacks.beforeRemoveMember({
            member: { id: "m-guest" },
            organization: { id: organization },
          }),
        );
      yield* removal();
      assert.deepEqual(changes[0].pools[0].users, ["other", "owner"]);
      assert.equal((yield* sql`select * from member where id = 'm-guest'`).length, 1);
      fail();
      const result = yield* Effect.exit(
        removal().pipe(Effect.andThen(sql`delete from member where id = 'm-guest'`)),
      );
      assert.equal(result._tag, "Failure");
      assert.equal((yield* sql`select * from member where id = 'm-guest'`).length, 1);
    }),
  );
});
import { SqlClient as Sql } from "effect/sql";
const SqlClient = Sql.SqlClient;

test("no network for organizations without pools or ordinary apps; absent signing key skips", async () => {
  await fixture(({ sql, hook, changes, noKey }) =>
    Effect.gen(function* () {
      yield* hook.appAccessChanged({ organization, apps: ["app_ordinary"] });
      yield* hook.appRemoving("app_ordinary");
      yield* noKey.appAccessChanged({ organization });
      yield* sql`update organization set metadata = '{}'`;
      yield* hook.appAccessChanged({ organization });
      yield* hook.memberRemoving({ organization, member: "m-guest" });
      yield* hook.organizationRemoving(organization);
      assert.equal(changes.length, 0);
    }),
  );
});

test("SDK app-removal hook revokes a pool before unlinking it and rolls back on worker failure", async () => {
  await fixture(({ sql, hook, changes, fail, recover, requestTransactions }) =>
    Effect.gen(function* () {
      const { AccessLifecycle } = yield* Effect.promise(() =>
        load(`${contracts}access-lifecycle.ts`),
      );
      const lifecycle = yield* hostedResourceLifecycle.pipe(
        Effect.provideService(AccessLifecycle, hook),
      );
      yield* sql`insert into hosted_app_account_links values (${pool})`;
      const remove = sql.withTransaction(
        lifecycle.hooks
          .appRemoving(pool)
          .pipe(Effect.andThen(sql`delete from executor_apps where id = ${pool}`)),
      );
      fail();
      assert.equal((yield* Effect.exit(remove))._tag, "Failure");
      assert.equal((yield* sql`select * from hosted_app_account_links`).length, 1);
      assert.equal((yield* sql`select * from executor_apps where id = ${pool}`).length, 1);
      recover();
      yield* remove;
      assert.equal(changes.at(-1).action, "pool-deleted");
      assert.equal(changes.at(-1).pool, pool);
      assert.deepEqual(requestTransactions, [true, true, true, true]);
      assert.equal((yield* sql`select * from hosted_app_account_links`).length, 0);
    }),
  );
});

test("organization deletion revokes recorded pools after owner-store erasure; person deletion fails closed", async () => {
  const { beforeUserDeletion } = await load("apps/hosted/cloud/src/implementation/access-hooks.ts");
  await fixture(({ sql, hook, changes, fail }) =>
    Effect.gen(function* () {
      yield* sql`delete from executor_apps`;
      yield* hook.organizationRemoving(organization);
      assert.equal(changes[0].action, "pool-deleted");
      assert.equal(changes[0].pool, pool);
      const callbacks = {
        userDeleting: (user: string) =>
          Effect.runPromise(hook.userDeleting(user).pipe(Effect.provideService(SqlClient, sql))),
      };
      yield* Effect.tryPromise(() => beforeUserDeletion(callbacks, "guest"));
      assert.equal(changes[1].action, "person-deleted");
      assert.equal(changes[1].user, "guest");
      fail();
      assert.equal(
        (yield* Effect.exit(
          Effect.tryPromise(() => beforeUserDeletion(callbacks, "guest")).pipe(
            Effect.andThen(sql`delete from "user" where id = 'guest'`),
          ),
        ))._tag,
        "Failure",
      );
      assert.equal((yield* sql`select * from "user" where id = 'guest'`).length, 1);
    }),
  );
});

test("group create/update/delete push each pool inside the writing transaction, with rollback on failure", async () => {
  const { hostedGroupHandlers } = await load(`${implementation}groups.ts`);
  const { HostedApi } = await load(`${contracts}api.ts`);
  await fixture(({ sql, changes, requestTransactions, fail, recover }) =>
    Effect.gen(function* () {
      const { RequireOrganization } = yield* Effect.promise(() =>
        load(`${contracts}organization.ts`),
      );
      // The fixture supplies an authenticated owner; exercise the real registered write handlers.
      const context = yield* Layer.build(
        hostedGroupHandlers.pipe(
          Layer.provide(Layer.succeed(RequireOrganization, (effect: any) => effect)),
        ),
      );
      const handlers = context.mapUnsafe.get(HostedApi.groups.groups.key).handlers;
      const call = (name: string, input: unknown) => handlers.get(name).handler(input);
      const group = yield* call("create", {
        payload: { name: "Friends", description: "", memberIds: ["m-guest"] },
      });
      assert.deepEqual(changes.at(-1).pools[0].users, ["owner"]);
      yield* sql`update hosted_app_access set audience = 'groups' where id = ${pool}`;
      yield* sql`insert into hosted_app_groups values (${organization}, ${pool}, ${group.id})`;
      const updated = yield* call("update", {
        params: { group: group.id },
        payload: {
          revision: group.revision,
          name: "Friends",
          description: "",
          memberIds: ["m-guest", "m-other"],
        },
      });
      assert.deepEqual(changes.at(-1).pools[0].users, ["guest", "other", "owner"]);
      fail();
      assert.equal(
        (yield* Effect.exit(
          call("update", {
            params: { group: group.id },
            payload: {
              revision: updated.revision,
              name: "Friends",
              description: "",
              memberIds: [],
            },
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* sql`select * from hosted_group_members where group_id = ${group.id}`).length,
        2,
      );
      assert.equal(
        (yield* Effect.exit(
          call("remove", { params: { group: group.id }, payload: { revision: updated.revision } }),
        ))._tag,
        "Failure",
      );
      assert.equal((yield* sql`select * from hosted_groups where id = ${group.id}`).length, 1);
      recover();
      yield* call("remove", {
        params: { group: group.id },
        payload: { revision: updated.revision },
      });
      assert.deepEqual(changes.at(-1).pools[0].users, ["owner"]);
      assert.equal((yield* sql`select * from hosted_groups where id = ${group.id}`).length, 0);
      assert.ok(requestTransactions.every(Boolean));
    }),
  );
});

test("a network failure rolls a share back, and failed group creation leaves no rows", async () => {
  const { poolAccessLifecycle } = await load(`${implementation}pool-access-hook.ts`);
  const { AccessLifecycle } = await load(`${contracts}access-lifecycle.ts`);
  const { hostedGroupHandlers } = await load(`${implementation}groups.ts`);
  const { HostedApi } = await load(`${contracts}api.ts`);
  const { RequireOrganization } = await load(`${contracts}organization.ts`);
  await fixture(({ sql, fail }) =>
    Effect.gen(function* () {
      const before = yield* sql`select * from hosted_app_access where id = ${pool}`;
      const unreachable = poolAccessLifecycle(
        Option.some(Redacted.make(secret)),
        "http://127.0.0.1:1",
      );
      assert.equal(
        (yield* Effect.exit(
          share(sql, "everyone").pipe(Effect.provideService(AccessLifecycle, unreachable)),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(yield* sql`select * from hosted_app_access where id = ${pool}`, before);
      fail();
      const context = yield* Layer.build(
        hostedGroupHandlers.pipe(
          Layer.provide(Layer.succeed(RequireOrganization, (effect: any) => effect)),
        ),
      );
      const handler = context.mapUnsafe
        .get(HostedApi.groups.groups.key)
        .handlers.get("create").handler;
      assert.equal(
        (yield* Effect.exit(
          handler({ payload: { name: "Rollback", description: "", memberIds: ["m-guest"] } }),
        ))._tag,
        "Failure",
      );
      assert.equal((yield* sql`select * from hosted_groups`).length, 0);
      assert.equal((yield* sql`select * from hosted_group_members`).length, 0);
    }),
  );
});

test("auth-record erasure notifies before its first delete, and a refusal leaves every auth record", async () => {
  const { deleteOrganizationRecords } = await load(`${implementation}organization-records.ts`);
  const { AuthenticationUnavailable } = await load(`${contracts}auth.ts`);
  await fixture(({ sql, hook, changes, fail, recover }) =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      const adapter = {
        findOne: async () => ({ logo: null }),
        findMany: async () => [],
        delete: async ({ model }: { model: string }) => {
          assert.equal(changes.at(-1).action, "pool-deleted");
          deleted.push(model);
        },
        deleteMany: async ({ model }: { model: string }) => {
          deleted.push(model);
        },
      };
      const removal = deleteOrganizationRecords(adapter, organization, (id: string) =>
        hook.organizationRemoving(id).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.mapError(() => new AuthenticationUnavailable()),
        ),
      );
      fail();
      assert.equal((yield* Effect.exit(removal))._tag, "Failure");
      assert.deepEqual(deleted, []);
      recover();
      yield* removal;
      assert.deepEqual(deleted, ["organization", "member", "invitation"]);
    }),
  );
});

for (const audience of ["private", "everyone", "groups"]) {
  for (const user of ["guest", "owner"]) {
    test(`removal and leave exclude ${user} from a ${audience} audience including the recorded owner`, async () => {
      await fixture(({ sql, hook, changes }) =>
        Effect.gen(function* () {
          yield* sql`update hosted_app_access set audience = ${audience} where id = ${pool}`;
          yield* sql`insert into hosted_groups (id, organization_id, name) values ('g-removal', ${organization}, 'Friends')`;
          yield* sql`insert into hosted_group_members values ('g-removal', 'm-guest'), ('g-removal', 'm-owner')`;
          yield* sql`insert into hosted_app_groups values (${organization}, ${pool}, 'g-removal')`;
          yield* hook.memberRemoving({ organization, member: `m-${user}` });
          assert.equal(changes.at(-1).pools[0].users.includes(user), false);
          assert.equal((yield* sql`select id from member where id = ${`m-${user}`}`).length, 1);
        }),
      );
    });
  }
}

test("user deletion revokes every owned pool from metadata before deleting the person, with retry on refusal", async () => {
  await fixture(({ sql, hook, changes, fail, recover }) =>
    Effect.gen(function* () {
      yield* sql`insert into organization values ('org-second', ${JSON.stringify({ basaltPools: { owner: { app: "app_second" }, guest: { app: "app_guest" } } })})`;
      yield* sql`delete from executor_apps`;
      fail();
      assert.equal((yield* Effect.exit(hook.userDeleting("owner")))._tag, "Failure");
      assert.equal(
        changes.length,
        3,
        "pool deletion retries twice before refusing account deletion",
      );
      assert.ok(changes.every((change: any) => change.action === "pool-deleted"));
      recover();
      const start = changes.length;
      yield* hook.userDeleting("owner");
      const sent = changes.slice(start);
      assert.deepEqual(
        sent
          .slice(0, -1)
          .map((change: any) => change.pool)
          .sort(),
        [pool, "app_second"],
      );
      assert.equal(sent.at(-1).action, "person-deleted");
      assert.equal(sent.at(-1).user, "owner");
      assert.equal((yield* sql`select id from "user" where id = 'owner'`).length, 1);
    }),
  );
});

test("pool deletion retries a lost acknowledgement with a fresh signed envelope", async () => {
  await fixture(({ sql, hook, changes, loseAcknowledgement }) =>
    Effect.gen(function* () {
      loseAcknowledgement();
      yield* hook.appRemoving(pool);
      assert.deepEqual(
        changes.map((change: any) => [change.action, change.pool]),
        [
          ["pool-deleted", pool],
          ["pool-deleted", pool],
        ],
      );
      assert.ok(changes[1].at > changes[0].at);
    }),
  );
});
