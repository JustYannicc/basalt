import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { contributedFixture } from "./contributed-accounts-fixture.ts";
import { load, implementation } from "./pool-access-fixture.ts";

import { forbidden, params } from "./contributed-accounts-assertions.ts";

for (const action of ["remove", "leave"]) {
  test(`native Better Auth ${action} commits and queues durable contributed cleanup; failed hook retries once`, async () => {
    await contributedFixture((f) =>
      Effect.gen(function* () {
        const account = yield* f.connect(f.guest);
        const ordinary = yield* f.connect(f.owner, "ordinary");
        const token = yield* f.token(f.guest);
        const saved = token.account ?? token;
        const { runContributedDeparture } = yield* Effect.promise(() =>
          load(`${implementation}contributed-departure-queue.ts`),
        );
        f.failRemove();
        const [member] =
          yield* f.sql`select id from member where "organizationId" = ${f.org.id} and "userId" = ${f.guest.id}`;
        yield* Effect.promise(() =>
          action === "remove"
            ? f.auth.api.removeMember({
                headers: f.owner.headers,
                body: { organizationId: f.org.id, memberIdOrEmail: member.id },
              })
            : f.auth.api.leaveOrganization({
                headers: f.guest.headers,
                body: { organizationId: f.org.id },
              }),
        );
        assert.equal((yield* f.sql`select id from member where id = ${member.id}`).length, 0);
        assert.equal(f.removals(), 0, "membership removal never waits for the app hook");
        const [job] =
          yield* f.sql`select id from hosted_contributed_departure_jobs where user_id = ${f.guest.id}`;
        assert.ok(job);
        assert.equal(
          (yield* f.sql`select * from hosted_contributed_departures where job = ${job.id}`).length,
          2,
        );
        const work = f.background(runContributedDeparture(job.id));
        assert.equal((yield* Effect.exit(work))._tag, "Failure");
        assert.equal(
          (yield* f.sql`select status from hosted_contributed_departure_jobs where id = ${job.id}`)[0]
            .status,
          "queued",
        );
        assert.equal((yield* f.sql`select id from member where id = ${member.id}`).length, 0);
        f.recoverRemove();
        yield* work;
        yield* work;
        assert.equal(f.removals(), 1, "retry after success cannot repeat remove");
        assert.ok(f.removeContexts().length > 0);
        for (const ctx of f.removeContexts())
          assert.equal(ctx.user, undefined, "departure remove has no current user");
        const remaining = yield* f.request(f.owner, "appList", { app: f.app.id });
        assert.deepEqual(
          remaining.map((l: any) => l.account.id),
          [ordinary.id],
        );
        assert.equal(
          (yield* f.sql`select * from hosted_app_account_links where account = ${saved.id}`).length,
          0,
        );
        assert.equal(
          (yield* f.sql`select id from executor_accounts where id = ${saved.id}`).length,
          1,
          "ordinary credentials remain saved after unlink",
        );
        assert.equal(
          (yield* f.sql`select status from hosted_contributed_departure_jobs where id = ${job.id}`)[0]
            .status,
          "succeeded",
        );
      }),
    );
  });
}

test("a successful remove hook is persisted if the unlink commit fails, so durable retry does not run it twice", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest);
      yield* f.sql`create table fixture_unlink_failure (fail boolean not null)`;
      yield* f.sql`insert into fixture_unlink_failure values (false)`;
      yield* f.sql`create function fixture_refuse_unlink() returns trigger language plpgsql as $$
      begin if (select fail from fixture_unlink_failure) then raise exception 'fixture unlink commit failed'; end if; return OLD; end $$`;
      yield* f.sql`create trigger fixture_refuse_unlink before delete on hosted_app_account_links for each row execute function fixture_refuse_unlink()`;
      f.afterRemove(() => Effect.runPromise(f.sql`update fixture_unlink_failure set fail = true`));
      yield* Effect.promise(() =>
        f.auth.api.leaveOrganization({
          headers: f.guest.headers,
          body: { organizationId: f.org.id },
        }),
      );
      const [job] = yield* f.sql`select id from hosted_contributed_departure_jobs`;
      const { runContributedDeparture } = yield* Effect.promise(() =>
        load(`${implementation}contributed-departure-queue.ts`),
      );
      const work = f.background(runContributedDeparture(job.id));
      assert.equal((yield* Effect.exit(work))._tag, "Failure");
      assert.equal(f.removals(), 1);
      assert.equal(
        (yield* f.sql`select account from hosted_app_account_links where account = ${account.id}`)
          .length,
        1,
      );
      const [binding] =
        yield* f.sql`select state from executor_account_connections where state -> 'account' ->> 'id' = ${account.id}`;
      const state = typeof binding.state === "string" ? JSON.parse(binding.state) : binding.state;
      assert.equal(state.interactive.retirement.removed, true);
      yield* f.sql`update fixture_unlink_failure set fail = false`;
      yield* work;
      yield* work;
      assert.equal(f.removals(), 1);
      assert.equal(
        (yield* f.sql`select account from hosted_app_account_links where account = ${account.id}`)
          .length,
        0,
      );
    }),
  );
});

test("departure snapshots preserve a new link after a member rejoins; ordinary app requirements stay manager-only", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const token = yield* f.token(f.guest);
      const account = token.account ?? token;
      const normalToken = yield* f.token(f.owner, "normalTokens");
      const ordinary = normalToken.account ?? normalToken;
      const normal = (yield* f.request(f.guest, "appList", { app: f.app.id })).find(
        (l: any) => l.account.id === ordinary.id,
      );
      assert.equal(normal.canRemove, false);
      yield* forbidden(f.request(f.guest, "appUnlink", params(f.app, "normalTokens", ordinary.id)));
      yield* f.request(f.owner, "appUnlink", params(f.app, "normalTokens", ordinary.id));
      yield* Effect.promise(() =>
        f.auth.api.leaveOrganization({
          headers: f.guest.headers,
          body: { organizationId: f.org.id },
        }),
      );
      const [job] = yield* f.sql`select id from hosted_contributed_departure_jobs`;
      yield* Effect.promise(() =>
        f.auth.api.addMember({
          body: { organizationId: f.org.id, userId: f.guest.id, role: "member" },
        }),
      );
      yield* f.request(f.guest, "appUnlink", params(f.app, "tokens", account.id));
      yield* f.request(f.guest, "appLink", params(f.app, "tokens", account.id));
      const { runContributedDeparture } = yield* Effect.promise(() =>
        load(`${implementation}contributed-departure-queue.ts`),
      );
      yield* f.background(runContributedDeparture(job.id));
      const after = yield* f.request(f.guest, "appList", { app: f.app.id });
      assert.equal(after.length, 1);
      assert.equal(after[0].account.id, account.id);
      assert.equal(f.removals(), 0);
    }),
  );
});

test("membership removal queues no cleanup for normal requirements or shared credentials", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const ordinary = yield* f.connect(f.owner, "ordinary");
      const shared = yield* f.connect(f.guest);
      yield* f.sql`update hosted_account_access set kind = 'shared', personal_user_id = null, audience = 'everyone' where account_id = ${shared.id}`;
      yield* Effect.promise(() =>
        f.auth.api.leaveOrganization({
          headers: f.guest.headers,
          body: { organizationId: f.org.id },
        }),
      );
      assert.equal((yield* f.sql`select id from hosted_contributed_departure_jobs`).length, 0);
      assert.equal(f.removals(), 0);
      const remaining = yield* f.request(f.owner, "appList", { app: f.app.id });
      assert.deepEqual(
        new Set(remaining.map((l: any) => l.account.id)),
        new Set([ordinary.id, shared.id]),
      );
    }),
  );
});
