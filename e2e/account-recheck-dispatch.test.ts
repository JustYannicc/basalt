import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { StorageError, type Executor } from "@executor-js/sdk/core";
import { runRecheckFixture } from "./account-recheck-fixture.ts";
import { makeAccountRechecks } from "../.upstream/apps/hosted/server/src/implementation/account-rechecks.ts";
import { AutomaticAccountCheck } from "../.upstream/apps/hosted/server/src/implementation/account-recheck-authority.ts";
import { makeDriverAccountHealth } from "../.upstream/packages/sdk/src/implementation/account-driver-health.ts";
import { makeExecutorStorage } from "../.upstream/packages/sdk/src/implementation/storage.ts";
import { database } from "../.upstream/packages/sdk/src/implementation/database.ts";
import { CurrentUserId } from "../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { hostedResourceLifecycle } from "../.upstream/apps/hosted/server/src/implementation/resource-lifecycle.ts";
import { accountMetadata } from "../.upstream/packages/sdk/src/implementation/accounts.ts";
import { StoredAccount } from "../.upstream/packages/sdk/src/contracts/storage.ts";
import { AccountAcquisitionBinding } from "../.upstream/packages/sdk/src/contracts/account-acquisition-driver.ts";

const driverOnly = (f: Parameters<Parameters<typeof runRecheckFixture>[0]>[0]) =>
  Effect.gen(function* () {
    const account = yield* f.add("driver");
    yield* f.sql`delete from hosted_app_account_links where account=${account.account}`;
    yield* f.sql`insert into executor_account_acquisitions values (${account.account},'organization:org',${account.provider},'token',2,null,'r2','binding2')`;
    return account;
  });

test("revoking membership after claim but during preflight prevents driver dispatch", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* driverOnly(f);
      let dispatched = 0;
      const health: Executor["accounts"]["health"] = ({ account }) =>
        Effect.gen(function* () {
          yield* f.sql`delete from member`.pipe(Effect.orDie);
          return {
            account,
            info: null,
            infoCheckedAt: null,
            apps: [],
            driver: {
              source: { kind: "driver" as const, id: "fixture", version: "1" },
              checkable: true,
              check: null,
            },
          };
        });
      const check: Executor["accounts"]["check"] = ({ account }) =>
        Effect.sync(() => {
          dispatched++;
          return { account, info: null, infoCheckedAt: null, apps: [] };
        });
      yield* makeAccountRechecks(f.sql, { accounts: { health, check } })("revoked");
      assert.equal(dispatched, 0);
    }),
  ));

test("the real SDK driver refuses revoked authority after resolving its source", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      const item = yield* driverOnly(f);
      const [target] = yield* f.queue.claim("lease");
      assert.ok(target);
      const account = yield* Schema.decodeUnknownEffect(StoredAccount)({
        id: item.account,
        owner: "organization:org",
        provider: item.provider,
        method: "token",
        label: "",
        description: null,
        createdAt: new Date(),
        site: null,
        encryptedCredentials: new Uint8Array(),
        credentialGeneration: 2,
        allowedHosts: null,
        identityId: null,
        oauthGrantId: null,
      });
      const binding = yield* Schema.decodeUnknownEffect(AccountAcquisitionBinding)({
        account: account.id,
        owner: account.owner,
        provider: account.provider,
        method: account.method,
        driver: "fixture",
        driverRevision: "r2",
        generation: 2,
        revision: "binding2",
        removal: null,
      });
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      let dispatched = 0;
      const lifecycle = yield* hostedResourceLifecycle;
      const driver = makeDriverAccountHealth(
        database(storage),
        {
          binding: () => Effect.succeed(binding),
          checkable: () => Effect.succeed(true),
          source: () =>
            Effect.gen(function* () {
              yield* f.sql`delete from member`.pipe(Effect.orDie);
              return {
                binding,
                source: { kind: "driver" as const, id: "fixture", version: "r2" },
                current: Effect.succeed(binding),
                check: () =>
                  Effect.sync(() => {
                    dispatched++;
                    return {};
                  }),
              };
            }),
        },
        { status: () => "check_failed", message: () => undefined },
        undefined,
        (current) =>
          lifecycle.hooks
            .accountsResolving([accountMetadata(current)])
            .pipe(
              Effect.flatMap((allowed) =>
                allowed.has(current.id) ? Effect.void : Effect.fail(new StorageError()),
              ),
            ),
      );
      const result = yield* Effect.result(
        driver
          .check(account)
          .pipe(Effect.provideService(AutomaticAccountCheck, { ...target, lease: "lease" })),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(dispatched, 0);
    }),
  ));

test("user-subject dispatch must retain its lease, membership and app link", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      const item = yield* f.add("user");
      yield* f.sql`update hosted_app_account_links set subject='owner' where account=${item.account}`;
      yield* f.sql`insert into hosted_app_access values (${item.app},'org','everyone','owner')`;
      const [target] = yield* f.queue.claim("user-lease");
      assert.ok(target);
      const lifecycle = yield* hostedResourceLifecycle;
      const account = yield* Schema.decodeUnknownEffect(StoredAccount)({
        id: item.account,
        owner: "organization:org",
        provider: item.provider,
        method: "token",
        label: "",
        description: null,
        createdAt: new Date(),
        site: null,
        encryptedCredentials: new Uint8Array(),
        credentialGeneration: 2,
        allowedHosts: null,
        identityId: null,
        oauthGrantId: null,
      });
      const allowed = lifecycle.hooks
        .accountsResolving([accountMetadata(account)])
        .pipe(
          Effect.provideService(CurrentUserId, "owner"),
          Effect.provideService(AutomaticAccountCheck, { ...target, lease: "user-lease" }),
        );
      assert.equal((yield* allowed).has(account.id), true);
      yield* f.sql`update hosted_account_rechecks set lease_until=now()-interval '1 second'`;
      assert.equal((yield* allowed).size, 0);
      yield* f.sql`update hosted_account_rechecks set lease_until=now()+interval '1 minute'`;
      yield* f.sql`update hosted_app_access set audience='groups'`;
      assert.equal((yield* allowed).size, 0);
      yield* f.sql`insert into hosted_app_groups values (${item.app},'group')`;
      yield* f.sql`insert into hosted_group_members values ('group','member')`;
      assert.equal((yield* allowed).has(account.id), true);
      yield* f.sql`delete from hosted_app_account_links`;
      assert.equal((yield* allowed).size, 0);
    }),
  ));
