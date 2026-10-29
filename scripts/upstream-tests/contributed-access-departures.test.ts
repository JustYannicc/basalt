import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { contributedFixture } from "./contributed-accounts-fixture.ts";
import { load, implementation } from "./pool-access-fixture.ts";

const jobs = (f: any) =>
  f.sql`select id from hosted_contributed_departure_jobs where user_id = ${f.guest.id}`;
const run = (f: any, id: string) =>
  Effect.gen(function* () {
    const { runContributedDeparture } = yield* Effect.promise(() =>
      load(`${implementation}contributed-departure-queue.ts`),
    );
    yield* f.background(runContributedDeparture(id));
  });

for (const change of ["private", "group-membership", "group-grant", "group-delete"]) {
  test(`${change} snapshots lost contributions and durably invokes remove`, async () => {
    await contributedFixture((f) =>
      Effect.gen(function* () {
        const account = yield* f.connect(f.guest);
        const ordinary = yield* f.connect(f.owner, "ordinary");
        const [member] =
          yield* f.sql`select id from member where "organizationId" = ${f.org.id} and "userId" = ${f.guest.id}`;
        if (change === "private") {
          yield* f.share({ kind: "private" });
        } else {
          const group = yield* f.group("create", {
            name: "Contributors",
            description: "",
            memberIds: [member.id],
          });
          yield* f.share({ kind: "groups", groups: [group.id] });
          assert.equal((yield* jobs(f)).length, 0, "retained use queues no departure");
          // Saving the same members deletes and recreates rows in one transaction.
          const kept = yield* f.group("update", { ...group, memberIds: [member.id] }, group.id);
          assert.equal((yield* jobs(f)).length, 0, "temporary group rewrite queues no departure");
          if (change === "group-membership")
            yield* f.group("update", { ...kept, memberIds: [] }, group.id);
          if (change === "group-grant") {
            const other = yield* f.group("create", {
              name: "Other",
              description: "",
              memberIds: [],
            });
            yield* f.share({ kind: "groups", groups: [other.id] });
          }
          if (change === "group-delete")
            yield* f.group("remove", { revision: kept.revision }, group.id);
        }
        assert.equal(f.removals(), 0, "access change does not wait on hooks");
        const queued = yield* jobs(f);
        assert.equal(queued.length, 1, "lost use must commit a cleanup job");
        yield* run(f, queued[0].id);
        yield* run(f, queued[0].id);
        assert.equal(f.removals(), 1);
        assert.equal(
          (yield* f.sql`select * from hosted_app_account_links where account = ${account.id}`)
            .length,
          0,
        );
        assert.equal(
          (yield* f.sql`select * from hosted_app_account_links where account = ${ordinary.id}`)
            .length,
          1,
        );
      }),
    );
  });
}

for (const alreadyLeft of [false, true]) {
  test(`native user deletion ${alreadyLeft ? "preserves pending" : "snapshots new"} durable departures`, async () => {
    await contributedFixture((f) =>
      Effect.gen(function* () {
        const account = yield* f.connect(f.guest);
        if (alreadyLeft)
          yield* Effect.promise(() =>
            f.auth.api.leaveOrganization({
              headers: f.guest.headers,
              body: { organizationId: f.org.id },
            }),
          );
        const before = yield* jobs(f);
        const response = (yield* Effect.promise(() =>
          f.auth.api.deleteUser({
            headers: f.guest.headers,
            body: { password: "fixture-password-1234" },
            asResponse: true,
          }),
        )) as Response;
        assert.equal(response.status, 200, yield* Effect.promise(() => response.text()));
        assert.equal((yield* f.sql`select id from "user" where id = ${f.guest.id}`).length, 0);
        assert.equal(
          (yield* f.sql`select id from member where "userId" = ${f.guest.id}`).length,
          0,
        );
        const queued = yield* jobs(f);
        assert.equal(queued.length, 1, "cleanup authority must survive the user row");
        if (alreadyLeft) assert.equal(queued[0].id, before[0].id);
        f.failRemove();
        assert.equal((yield* Effect.exit(run(f, queued[0].id)))._tag, "Failure");
        assert.equal(
          (yield* f.sql`select status from hosted_contributed_departure_jobs where id = ${queued[0].id}`)[0]
            .status,
          "queued",
        );
        f.recoverRemove();
        yield* run(f, queued[0].id);
        yield* run(f, queued[0].id);
        assert.equal(f.removals(), 1);
        assert.equal(
          (yield* f.sql`select * from hosted_app_account_links where account = ${account.id}`)
            .length,
          0,
        );
        assert.equal(
          (yield* f.sql`select * from executor_accounts where id = ${account.id}`).length,
          0,
        );
        const [binding] =
          yield* f.sql`select state::jsonb -> 'interactive' -> 'retirement' ->> 'removed' as removed from executor_account_connections where state::jsonb -> 'account' ->> 'id' = ${account.id}`;
        assert.equal(binding.removed, "true", "the SDK keeps the successful remove receipt");
      }),
    );
  });
}

test("pending departures never enter an old provisioning dispatch batch", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      yield* f.connect(f.guest);
      yield* Effect.promise(() =>
        f.auth.api.leaveOrganization({
          headers: f.guest.headers,
          body: { organizationId: f.org.id },
        }),
      );
      assert.equal((yield* jobs(f)).length, 1);
      const oldBatch = Schema.Array(
        Schema.Struct({
          id: Schema.String,
          kind: Schema.Literals(["user", "member", "team", "billing", "domain"]),
        }),
      );
      const claimed = yield* f.sql`with candidates as (
      select id from hosted_provisioning where available_at <= now() and status = 'queued'
      order by case when kind = 'team' then 0 else 1 end, available_at for update skip locked limit 50
    ) update hosted_provisioning job set available_at = now() + interval '30 seconds'
      from candidates where job.id = candidates.id returning job.id, job.kind`;
      const decoded = yield* Schema.decodeUnknownEffect(oldBatch)(claimed);
      assert.ok(decoded.some((job: any) => job.kind === "billing"));
    }),
  );
});

test("unsharing cleanup preserves a later relink, and rolled-back access changes enqueue nothing", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const saved = yield* f.token(f.guest);
      const account = saved.account ?? saved;
      const { shareApp } = yield* Effect.promise(() => load(`${implementation}resource-access.ts`));
      const rollback = f.sql.withTransaction(
        Effect.gen(function* () {
          const [policy] =
            yield* f.sql`select revision from hosted_app_access where id = ${f.app.id}`;
          yield* f.as(f.owner, shareApp(f.app.id, { kind: "private" }, policy.revision));
          return yield* Effect.fail("fixture rollback");
        }),
      );
      assert.equal((yield* Effect.exit(rollback))._tag, "Failure");
      assert.equal((yield* jobs(f)).length, 0);
      yield* f.share({ kind: "private" });
      const [job] = yield* jobs(f);
      yield* f.share({ kind: "everyone" });
      const params = { app: f.app.id, requirement: "tokens", account: account.id };
      yield* f.request(f.guest, "appUnlink", params);
      yield* f.request(f.guest, "appLink", params);
      yield* run(f, job.id);
      assert.equal(
        (yield* f.sql`select * from hosted_app_account_links where account = ${account.id}`).length,
        1,
      );
      assert.equal(f.removals(), 0);
    }),
  );
});

test("creators lose contributed accounts when group use is removed even though they can still manage", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.owner);
      const group = yield* f.group("create", { name: "Empty", description: "", memberIds: [] });
      yield* f.share({ kind: "groups", groups: [group.id] });
      const [job] =
        yield* f.sql`select id from hosted_contributed_departure_jobs where user_id = ${f.owner.id}`;
      assert.ok(job);
      const { drainContributedDepartures } = yield* Effect.promise(() =>
        load(`${implementation}contributed-departure-queue.ts`),
      );
      yield* f.background(drainContributedDepartures);
      assert.equal(
        (yield* f.sql`select * from hosted_app_account_links where account = ${account.id}`).length,
        0,
      );
      assert.equal(f.removals(), 1);
    }),
  );
});
