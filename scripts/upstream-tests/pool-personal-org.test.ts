import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { personalOrgFixture } from "./pool-personal-org-fixture.ts";

const owned = (sql: any, user: string) => sql`select o.id, o.name, o.slug from organization o
  join member m on m."organizationId" = o.id where m."userId" = ${user} and m.role = 'owner'`;

test("native invite acceptance queues personal organization creation and pool provisioning exactly once", async () => {
  await personalOrgFixture(({ sql, guest, accept, jobs, work, checks, seatChecks }) =>
    Effect.gen(function* () {
      const accepted = yield* accept();
      assert.equal(accepted.member.role, "member");
      assert.equal((yield* owned(sql, guest.id)).length, 0);
      const [job] = yield* jobs();
      assert.ok(job, "the membership trigger queues durable setup");
      yield* work(job.id);
      const organizations = yield* owned(sql, guest.id);
      assert.equal(organizations.length, 1);
      assert.equal(organizations[0].name, "Guest Person");
      assert.equal(organizations[0].slug, "guest-person");
      const personal = organizations[0].id;
      assert.equal(
        (yield* sql`select id from hosted_provisioning where kind = 'team' and organization_id = ${personal} and status = 'queued'`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`select id from hosted_provisioning where kind = 'member' and organization_id = ${personal} and user_id = ${guest.id}`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`select id from hosted_provisioning where kind = 'billing' and organization_id = ${personal}`)
          .length,
        2,
      );
      assert.equal(
        (yield* sql`select organization_id from cloud_organization_setup where user_id = ${guest.id}`)[0]
          .organization_id,
        personal,
      );
      yield* work(job.id);
      assert.deepEqual(yield* owned(sql, guest.id), organizations);
      assert.equal(checks(), 1, "the account's own v1 eligibility was checked");
      assert.ok(
        seatChecks() > 0,
        "native invitation acceptance retains its membership allowance check",
      );
    }),
  );
});

test("an invitee who already owns an organization creates none and skips the eligibility lookup", async () => {
  await personalOrgFixture(({ sql, auth, guest, accept, jobs, work, checks }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        auth.api.createOrganization({
          headers: guest.headers,
          body: { name: "Existing", slug: "existing" },
        }),
      );
      const before = yield* owned(sql, guest.id);
      yield* accept();
      for (const job of yield* jobs()) yield* work(job.id);
      assert.deepEqual(yield* owned(sql, guest.id), before);
      assert.equal(checks(), 0);
    }),
  );
});

test("acceptance survives personal-org storage failure and the same durable job repairs it", async () => {
  await personalOrgFixture(({ sql, guest, org, accept, jobs, work }) =>
    Effect.gen(function* () {
      // Fail only personal team creation, after the invitation membership committed.
      yield* sql`create function fail_personal_team() returns trigger language plpgsql as $$
      begin raise exception 'fixture personal team unavailable'; end $$`;
      yield* sql`create trigger fail_personal_team before insert on cloud_organization_setup for each row execute function fail_personal_team()`;
      const accepted = yield* accept();
      assert.equal(accepted.invitation.status, "accepted");
      const [job] = yield* jobs();
      assert.equal((yield* Effect.exit(work(job.id)))._tag, "Failure");
      assert.equal((yield* owned(sql, guest.id)).length, 0);
      assert.equal(
        (yield* sql`select id from member where "organizationId" = ${org.id} and "userId" = ${guest.id}`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`select status from hosted_provisioning where id = ${job.id}`)[0].status,
        "queued",
      );
      yield* sql`drop trigger fail_personal_team on cloud_organization_setup`;
      yield* work(job.id);
      yield* work(job.id);
      assert.equal((yield* owned(sql, guest.id)).length, 1);
      assert.equal(
        (yield* sql`select status from hosted_provisioning where id = ${job.id}`)[0].status,
        "succeeded",
      );
    }),
  );
});

for (const v1 of ["v1", "unavailable"]) {
  test(`the personal-org job preserves acceptance while eligibility is ${v1}, then retries`, async () => {
    await personalOrgFixture(({ sql, guest, accept, jobs, work, setV1 }) =>
      Effect.gen(function* () {
        setV1(v1);
        yield* accept();
        const [job] = yield* jobs();
        assert.equal((yield* Effect.exit(work(job.id)))._tag, "Failure");
        assert.equal((yield* owned(sql, guest.id)).length, 0);
        setV1("continue");
        yield* work(job.id);
        assert.equal((yield* owned(sql, guest.id)).length, 1);
      }),
    );
  });
}

test("two direct member joins create one personal organization and use upstream collision suffixes", async () => {
  await personalOrgFixture(({ sql, auth, owner, guest, org, jobs, work }) =>
    Effect.gen(function* () {
      const second: any = yield* Effect.promise(() =>
        auth.api.createOrganization({
          headers: owner.headers,
          body: { name: "Another", slug: "guest-person" },
        }),
      );
      for (const organizationId of [org.id, second.id])
        yield* Effect.promise(() =>
          auth.api.addMember({ body: { organizationId, userId: guest.id, role: "member" } }),
        );
      const joined =
        yield* sql`select id from hosted_provisioning where kind = 'member' and user_id = ${guest.id}`;
      assert.equal(joined.length, 2);
      yield* Effect.all(
        joined.map((job: any) => work(job.id)),
        { concurrency: 2 },
      );
      const organizations = yield* owned(sql, guest.id);
      assert.equal(organizations.length, 1);
      assert.match(organizations[0].slug, /^guest-person-[a-f0-9]{6}$/);
    }),
  );
});

test("an earlier onboarding record without current ownership cannot prevent personal team repair", async () => {
  await personalOrgFixture(({ sql, guest, org, accept, jobs, work, checks }) =>
    Effect.gen(function* () {
      yield* sql`insert into cloud_organization_setup (user_id, organization_id, applied) values (${guest.id}, ${org.id}, true)`;
      yield* accept();
      const [job] = yield* jobs();
      yield* work(job.id);
      yield* work(job.id);
      assert.equal((yield* owned(sql, guest.id)).length, 1);
      assert.equal(
        checks(),
        0,
        "allowsOrganization preserves upstream's completed-setup eligibility",
      );
      assert.equal(
        (yield* sql`select organization_id from cloud_organization_setup where user_id = ${guest.id}`)[0]
          .organization_id,
        org.id,
      );
    }),
  );
});

test("verification after a direct join queues repair, and an unverified member gets no personal team", async () => {
  await personalOrgFixture(({ sql, auth, guest, org, work }) =>
    Effect.gen(function* () {
      yield* sql`update "user" set "emailVerified" = false where id = ${guest.id}`;
      yield* Effect.promise(() =>
        auth.api.addMember({ body: { organizationId: org.id, userId: guest.id, role: "member" } }),
      );
      const [first] =
        yield* sql`select id from hosted_provisioning where kind = 'member' and user_id = ${guest.id}`;
      yield* work(first.id);
      assert.equal((yield* owned(sql, guest.id)).length, 0);
      yield* sql`update "user" set "emailVerified" = true where id = ${guest.id}`;
      const [retry] =
        yield* sql`select id from hosted_provisioning where kind = 'member' and user_id = ${guest.id} and id <> ${first.id}`;
      assert.ok(retry);
      yield* work(retry.id);
      assert.equal((yield* owned(sql, guest.id)).length, 1);
    }),
  );
});

test("an invitee who signed up by email code, with no display name, still gets their own organization", async () => {
  await personalOrgFixture(({ sql, guest, accept, jobs, work }) =>
    Effect.gen(function* () {
      // Better Auth's email-code sign-up stores an empty name.
      yield* sql`update "user" set name = '' where id = ${guest.id}`;
      yield* accept();
      const [job] = yield* jobs();
      assert.ok(job);
      yield* work(job.id);
      const organizations = yield* owned(sql, guest.id);
      assert.equal(organizations.length, 1);
      assert.equal(organizations[0].name, "Guest");
    }),
  );
});

test("native organization creates strip reserved pool metadata; updates refuse metadata and preserve SQL records", async () => {
  await personalOrgFixture(({ sql, auth, owner }) =>
    Effect.gen(function* () {
      const request = (path: string, body: unknown) =>
        auth.handler(
          new Request(`http://localhost:3000/api/auth/organization/${path}`, {
            method: "POST",
            headers: {
              cookie: owner.headers.get("cookie"),
              "content-type": "application/json",
              origin: "http://localhost:3000",
            },
            body: JSON.stringify(body),
          }),
        );
      const response = yield* Effect.promise(() =>
        request("create", {
          name: "Metadata",
          slug: "metadata",
          keepCurrentActiveOrganization: true,
          metadata: { purpose: "retained", basaltPools: { [owner.id]: { app: "app_victim" } } },
        }),
      );
      assert.equal(response.status, 200, yield* Effect.promise(() => response.clone().text()));
      const created = yield* Effect.promise(() => response.json());
      const metadata = () =>
        sql`select metadata::jsonb as metadata from organization where id = ${created.id}`;
      assert.deepEqual((yield* metadata())[0].metadata, { purpose: "retained" });
      // Provisioning's direct SQL remains authoritative and ordinary display edits preserve it.
      const pools = { [owner.id]: { app: "app_real", account: "acc_real" } };
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb, '{basaltPools}', ${JSON.stringify(pools)}::jsonb)::text where id = ${created.id}`;
      const before = yield* metadata();
      for (const supplied of [
        { purpose: "changed", basaltPools: { [owner.id]: { app: "app_victim" } } },
        { purpose: "changed" },
        {},
      ]) {
        // Server API calls bypass the HTTP field guard, exercising the plugin hook itself.
        const updated = yield* Effect.promise(() =>
          auth.api.updateOrganization({
            headers: owner.headers,
            asResponse: true,
            body: { organizationId: created.id, data: { metadata: supplied } },
          }),
        );
        assert.equal(updated.status, 400, yield* Effect.promise(() => updated.clone().text()));
        assert.deepEqual(yield* metadata(), before);
      }
      const blocked = yield* Effect.promise(() =>
        request("update", {
          organizationId: created.id,
          data: { name: "Unsafe", metadata: { basaltPools: {} } },
        }),
      );
      assert.equal(blocked.status, 400);
      for (const data of [
        { name: "Renamed" },
        { slug: "renamed" },
        { logo: "https://example.invalid/icon.png" },
        { logo: null },
      ]) {
        const updated = yield* Effect.promise(() =>
          request("update", { organizationId: created.id, data }),
        );
        assert.equal(updated.status, 200, yield* Effect.promise(() => updated.clone().text()));
        assert.deepEqual(yield* metadata(), before);
      }
    }),
  );
});
