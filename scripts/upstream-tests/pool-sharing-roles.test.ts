import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeAuth } from "./pool-sharing-auth-fixture.ts";

test("native removal and leave both fail closed and succeed on retry", async () => {
  const { auth, db, owner, guest, spare, org, removing, fail, recover } = await nativeAuth();
  const first = await auth.api.addMember({
    body: { organizationId: org.id, userId: guest.id, role: "member" },
  });
  const second = await auth.api.addMember({
    body: { organizationId: org.id, userId: spare.id, role: "member" },
  });
  fail();
  await assert.rejects(
    auth.api.removeMember({
      headers: owner.headers,
      body: { organizationId: org.id, memberIdOrEmail: first.id },
    }),
    /No member was removed/,
  );
  assert.ok(db.member.some((row) => row.id === first.id));
  await assert.rejects(
    auth.api.leaveOrganization({ headers: spare.headers, body: { organizationId: org.id } }),
    /No member was removed/,
  );
  assert.ok(db.member.some((row) => row.id === second.id));
  recover();
  await auth.api.removeMember({
    headers: owner.headers,
    body: { organizationId: org.id, memberIdOrEmail: first.id },
  });
  await auth.api.leaveOrganization({ headers: spare.headers, body: { organizationId: org.id } });
  assert.equal(
    db.member.some((row) => row.id === first.id || row.id === second.id),
    false,
  );
  assert.deepEqual(
    removing.map((row) => row.member),
    [first.id, second.id, first.id, second.id],
  );
});

test("native database user-delete hook prevents deletion on failure, even while self-service deletion is disabled", async () => {
  const { auth, db, guest, deleting, fail, recover } = await nativeAuth();
  const context = await auth.$context;
  const response = await auth.api.deleteUser({
    headers: guest.headers,
    body: {},
    asResponse: true,
  });
  assert.notEqual(response.status, 200, "self-service deletion is disabled");
  fail();
  await assert.rejects(
    context.internalAdapter.deleteUser(guest.id),
    /Your account was not deleted/,
  );
  assert.ok(db.user.some((row) => row.id === guest.id));
  recover();
  await context.internalAdapter.deleteUser(guest.id);
  assert.equal(
    db.user.some((row) => row.id === guest.id),
    false,
  );
  assert.deepEqual(deleting, [guest.id, guest.id]);
});

test("the existing global-admin delete route reaches the user hook while self-service deletion stays disabled", async () => {
  const { auth, db, owner, guest, deleting, fail, recover } = await nativeAuth();
  db.user.find((row) => row.id === owner.id).role = "admin";
  fail();
  await assert.rejects(
    auth.api.removeUser({ headers: owner.headers, body: { userId: guest.id } }),
    /Your account was not deleted/,
  );
  assert.ok(db.user.some((row) => row.id === guest.id));
  recover();
  await auth.api.removeUser({ headers: owner.headers, body: { userId: guest.id } });
  assert.equal(
    db.user.some((row) => row.id === guest.id),
    false,
  );
  assert.deepEqual(deleting, [guest.id, guest.id]);
});

test("a refused sole-owner leave does not send a member-removal projection", async () => {
  const { auth, db, owner, org, removing } = await nativeAuth();
  await assert.rejects(
    auth.api.leaveOrganization({ headers: owner.headers, body: { organizationId: org.id } }),
    /only owner/i,
  );
  assert.equal(db.member.find((row) => row.userId === owner.id).role, "owner");
  assert.deepEqual(removing, []);
});
