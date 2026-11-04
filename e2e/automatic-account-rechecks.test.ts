import { runRecheckFixture } from "./account-recheck-fixture.ts";
import {
  CurrentOrganization,
  OrganizationId,
} from "../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { CurrentUserId } from "../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { GroupDatabase } from "../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { accountRecheckStatus } from "../.upstream/apps/hosted/server/src/implementation/account-rechecks.ts";
import { AccountId, OwnerId, type Executor } from "@executor-js/sdk/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { makeAccountRechecks } from "../.upstream/apps/hosted/server/src/implementation/account-rechecks.ts";
import {
  AutomaticAccountCheck,
  automaticCheckAccounts,
} from "../.upstream/apps/hosted/server/src/implementation/account-recheck-authority.ts";

test("queues missing, changed version, changed generation and six-hour checks, leaving fresh current checks alone", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      const fresh = yield* f.add("fresh");
      yield* f.checked(fresh);
      const version = yield* f.add("version");
      yield* f.checked(version, "old-version");
      const generation = yield* f.add("generation");
      yield* f.checked(generation, generation.version, 1);
      const old = yield* f.add("old");
      yield* f.checked(old, old.version, 2, 7);
      yield* f.add("missing");
      const claimed = yield* f.queue.claim("first");
      assert.deepEqual(claimed.map((entry) => entry.account).sort(), [
        "acc_generation",
        "acc_missing",
        "acc_old",
        "acc_version",
      ]);
      assert.deepEqual(yield* f.queue.claim("overlap"), []);
      const [credential] =
        yield* f.sql`select encrypted_credentials from executor_accounts where id = 'acc_generation'`;
      assert.ok(credential);
      assert.equal(credential.encrypted_credentials, "keep-me");
    }),
  ));

test("caps the batch and spaces accounts of the same provider family across concurrent invocations", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      for (let i = 0; i < 12; i++) yield* f.add(`a${i}`, i < 8 ? "same-vendor" : `vendor-${i}`);
      const batches = yield* Effect.all([f.queue.claim("one"), f.queue.claim("two")], {
        concurrency: 2,
      });
      assert.ok(batches.every((batch) => batch.length <= 4));
      const all = batches.flat();
      assert.equal(new Set(all.map((entry) => entry.account)).size, all.length);
      assert.equal(all.filter((entry) => entry.provider === "same-vendor").length, 1);
      assert.equal(all.length, 5);
      const [summary] = yield* f.sql`select count(*)::int as count from hosted_account_rechecks`;
      assert.ok(summary);
      assert.equal(summary.count, 5);
    }),
  ));

test("expires interrupted leases, rejects old completion and preserves cooldown after a failed attempt", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("retry");
      const [first] = yield* f.queue.claim("old");
      assert.ok(first);
      yield* f.sql`update hosted_account_rechecks set lease_until=now()-interval '1 second', next_at=now()-interval '1 second', started_at=now()-interval '6 minutes', provider_next_at=now()-interval '1 second'`;
      assert.equal((yield* f.queue.claim("new")).length, 1);
      yield* f.queue.finish(first.account, "old", "healthy", false);
      let [row] = yield* f.sql`select lease, outcome from hosted_account_rechecks`;
      assert.ok(row);
      assert.equal(row.lease, "new");
      assert.equal(row.outcome, "running");
      yield* f.queue.finish(first.account, "new", "failed", true);
      [row] =
        yield* f.sql`select lease, outcome, next_at > now()+interval '14 minutes' as delayed from hosted_account_rechecks`;
      assert.ok(row);
      assert.equal(row.lease, null);
      assert.equal(row.outcome, "failed");
      assert.equal(row.delayed, true);
      assert.deepEqual(yield* f.queue.claim("too-soon"), []);
    }),
  ));

test("rechecks freshness after claiming and invokes the explicit path only for a still-stale account", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("changed");
      yield* f.add("manual-won");
      const called: string[] = [];
      const health: Executor["accounts"]["health"] = ({ account, apps }) =>
        Effect.succeed({
          account,
          info: null,
          infoCheckedAt: null,
          apps: apps.map((app) => ({
            app,
            checkable: true,
            check:
              account === "acc_manual-won"
                ? { status: "healthy" as const, checkedAt: new Date(), current: true }
                : null,
          })),
        });
      const check: Executor["accounts"]["check"] = (input) =>
        Effect.sync(() => {
          called.push(input.account);
          return {
            account: input.account,
            info: null,
            infoCheckedAt: null,
            apps: input.apps.map((app) => ({
              app,
              checkable: true,
              check: {
                status: "check_failed" as const,
                checkedAt: new Date(),
                current: true,
                failure: { phase: "invoke" as const, tag: "HostAccountsInvalid" as const },
              },
            })),
          };
        });
      yield* makeAccountRechecks(f.sql, { accounts: { health, check } })("run");
      assert.deepEqual(called, ["acc_changed"]);
      const rows =
        yield* f.sql`select account_id, outcome from hosted_account_rechecks order by account_id`;
      assert.deepEqual(rows, [
        { account_id: "acc_changed", outcome: "failed" },
        { account_id: "acc_manual-won", outcome: "skipped" },
      ]);
    }),
  ));

test("host authority admits only the exact leased account and fails closed after unlink or expiry", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      const item = yield* f.add("bound");
      const [candidate] = yield* f.queue.claim("lease");
      assert.ok(candidate);
      const account = { id: candidate.account, owner: candidate.owner };
      const accounts = [account];
      const allowed = automaticCheckAccounts(f.sql, accounts).pipe(
        Effect.provideService(AutomaticAccountCheck, { ...candidate, lease: "lease" }),
      );
      assert.equal((yield* allowed).has(candidate.account), true);
      assert.equal((yield* automaticCheckAccounts(f.sql, accounts)).size, 0);
      assert.equal(
        (yield* automaticCheckAccounts(f.sql, [
          { ...account, id: AccountId.make("acc_someone-else") },
        ]).pipe(Effect.provideService(AutomaticAccountCheck, { ...candidate, lease: "lease" })))
          .size,
        0,
      );
      yield* f.sql`delete from hosted_app_account_links where app=${item.app}`;
      assert.equal((yield* allowed).size, 0);
    }),
  ));

test("a rate-limited check defers every account in its provider family", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("limited-a", "vendor");
      yield* f.add("limited-b", "vendor");
      const [target] = yield* f.queue.claim("limited");
      assert.ok(target);
      yield* f.queue.finish(target.account, "limited", "failed", true, true);
      // Expiring only ordinary spacing cannot bypass the longer provider cooldown.
      yield* f.sql`update hosted_account_rechecks set started_at=now()-interval '2 minutes'`;
      assert.deepEqual(yield* f.queue.claim("wait"), []);
      yield* f.sql`update hosted_account_rechecks set provider_next_at=now()-interval '1 second'`;
      const [next] = yield* f.queue.claim("after");
      assert.ok(next);
      assert.notEqual(next.account, target.account);
    }),
  ));

test("driver checks become due after generation or binding revision changes, without needing an app link", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      for (const id of ["driver-current", "driver-changed"]) {
        const account = yield* f.add(id);
        yield* f.sql`delete from hosted_app_account_links where account=${account.account}`;
        yield* f.sql`insert into executor_account_acquisitions values
      (${account.account},'organization:org',${account.provider},'token',2,null,'r2','binding2')`;
        yield* f.sql`insert into executor_account_driver_checks values
      (${account.account},true,'r2',${id === "driver-current" ? "binding2" : "binding1"},2,now())`;
      }
      const targets = yield* f.queue.claim("drivers");
      assert.deepEqual(
        targets.map(({ account, app }) => ({ account, app })),
        [{ account: "acc_driver-changed", app: null }],
      );
    }),
  ));

test("the admin readout reports only its organization and refuses ordinary members", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("our-account");
      yield* f.add("other-account");
      const initial = yield* f.queue.claim("before-move");
      for (const target of initial)
        yield* f.queue.finish(target.account, "before-move", "skipped", false);
      yield* f.sql`update hosted_account_rechecks set next_at=now()-interval '1 second', provider_next_at=now()-interval '1 second'`;
      yield* f.sql`insert into organization values ('other-org')`;
      yield* f.sql`insert into member values ('other-member','other-org','owner','owner')`;
      yield* f.sql`update hosted_account_access set organization_id='other-org' where account_id='acc_other-account'`;
      yield* f.sql`update executor_accounts set owner='organization:other-org' where id='acc_other-account'`;
      yield* f.sql`update executor_apps set owner='organization:other-org' where id='app_acc_other-account'`;
      const targets = yield* f.queue.claim("mixed-run");
      for (const target of targets)
        yield* f.queue.finish(
          target.account,
          "mixed-run",
          target.organization === "org" ? "healthy" : "failed",
          false,
        );
      const status = accountRecheckStatus.pipe(
        Effect.provideService(GroupDatabase, Effect.succeed(f.sql)),
        Effect.provideService(CurrentOrganization, {
          organization: OrganizationId.make("org"),
          owner: OwnerId.make("organization:org"),
          role: "owner",
        }),
        Effect.provideService(CurrentUserId, "owner"),
      );
      const value = yield* status;
      assert.equal(value.lastRun?.accounts, 1);
      assert.equal(value.lastRun?.outcome, "healthy");
      assert.deepEqual(Object.keys(value).sort(), [
        "intervalHours",
        "lastRun",
        "maximumPerRun",
        "providerSpacingSeconds",
      ]);
      assert.equal(JSON.stringify(value).includes("keep-me"), false);
      yield* f.sql`update member set role='member' where id='member'`;
      const denied = yield* Effect.result(status);
      assert.equal(denied._tag, "Failure");
    }),
  ));
