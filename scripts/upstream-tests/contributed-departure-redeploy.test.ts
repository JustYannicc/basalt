import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Logger } from "effect";
import { appSource, contributedFixture } from "./contributed-accounts-fixture.ts";
import { load, implementation } from "./pool-access-fixture.ts";

for (const change of ["opt-out", "removed requirement"]) {
  test(`queued contributed departure survives deploying ${change}`, async () => {
    await contributedFixture((f) =>
      Effect.gen(function* () {
        const account = yield* f.connect(f.guest);
        yield* Effect.promise(() =>
          f.auth.api.leaveOrganization({
            headers: f.guest.headers,
            body: { organizationId: f.org.id },
          }),
        );
        const [job] = yield* f.sql`select id, status from hosted_contributed_departure_jobs`;
        assert.equal(job.status, "queued");
        yield* f.as(
          f.owner,
          f.executor.apps.deploy({
            app: f.app.id,
            owner: f.app.owner,
            files: [
              {
                path: "index.ts",
                content:
                  change === "opt-out"
                    ? appSource.replace(
                        "shared: subscription.many().contributed()",
                        "shared: subscription.many()",
                      )
                    : appSource
                        .replace("shared: subscription.many().contributed(), ", "")
                        .replace("shared: handlers, ", ""),
              },
            ],
          }),
        );
        const [deployment] =
          yield* f.sql`select d.requirements::jsonb -> 'accounts' -> 'shared' as requirement
        from executor_apps a join executor_deployments d on d.id = a.active_deployment
        where a.id = ${f.app.id}`;
        if (change === "opt-out") assert.equal(deployment.requirement.contributed, false);
        else assert.equal(deployment.requirement, null);
        assert.equal(
          (yield* f.sql`select account from hosted_app_account_links where account = ${account.id}`)
            .length,
          1,
          "the link remains queued for departure cleanup after redeploy",
        );
        assert.equal(f.removals(), 0);
        const { runContributedDeparture } = yield* Effect.promise(() =>
          load(`${implementation}contributed-departure-queue.ts`),
        );
        yield* f.background(runContributedDeparture(job.id));
        assert.equal(
          (yield* f.sql`select account from hosted_app_account_links where account = ${account.id}`)
            .length,
          0,
          "the departure snapshot still authorizes unlink after redeploy",
        );
        assert.equal(f.removals(), 1, "the acquiring version's remove hook runs exactly once");
        yield* f.background(runContributedDeparture(job.id));
        assert.equal(f.removals(), 1);
        assert.equal(
          (yield* f.sql`select status from hosted_contributed_departure_jobs where id = ${job.id}`)[0]
            .status,
          "succeeded",
        );
      }),
    );
  });
}

test("a queued departure logs its settlement when app deletion already retired the contribution", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest);
      yield* Effect.promise(() =>
        f.auth.api.leaveOrganization({
          headers: f.guest.headers,
          body: { organizationId: f.org.id },
        }),
      );
      const [job] = yield* f.sql`select id from hosted_contributed_departure_jobs`;
      yield* f.as(f.owner, f.executor.apps.remove({ app: f.app.id, owner: f.app.owner }));
      assert.equal((yield* f.sql`select id from executor_apps where id = ${f.app.id}`).length, 0);
      assert.equal(
        (yield* f.sql`select id from executor_accounts where id = ${account.id}`).length,
        0,
      );
      assert.equal(f.removals(), 1);
      const { runContributedDeparture } = yield* Effect.promise(() =>
        load(`${implementation}contributed-departure-queue.ts`),
      );
      const lines: unknown[] = [];
      const capture = Logger.make((options) => {
        const [message, fields] = options.message as readonly unknown[];
        if (message === "Contributed departure link settled") lines.push(fields);
      });
      yield* f
        .background(runContributedDeparture(job.id))
        .pipe(Effect.provide(Logger.layer([capture])));
      assert.deepEqual(lines, [
        {
          job: job.id,
          app: f.app.id,
          requirement: "shared",
          account: account.id,
          outcome: "snapshot_no_longer_current",
        },
      ]);
      assert.equal(
        (yield* f.sql`select account from hosted_app_account_links where account = ${account.id}`)
          .length,
        0,
      );
      assert.equal(f.removals(), 1, "the stale job cannot repeat app deletion's remove hook");
      assert.equal(
        (yield* f.sql`select status from hosted_contributed_departure_jobs where id = ${job.id}`)[0]
          .status,
        "succeeded",
      );
    }),
  );
});
