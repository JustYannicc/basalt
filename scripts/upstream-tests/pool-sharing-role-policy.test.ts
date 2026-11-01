import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeAuth } from "./pool-sharing-auth-fixture.ts";

const rejected = [
  "owner",
  "admin,owner",
  "member,admin",
  "admin, owner",
  "admin,admin",
  " member",
  "admin ",
];

for (const role of ["admin", "member"]) {
  test(`direct server add, invite, accept and promotion allow single ${role}`, async () => {
    const { auth, db, owner, guest, spare, org, added } = await nativeAuth();
    const member = await auth.api.addMember({
      body: { organizationId: org.id, userId: guest.id, role },
    });
    assert.equal(member.role, role);
    for (const newRole of ["admin", "member"]) {
      const changed = await auth.api.updateMemberRole({
        headers: owner.headers,
        body: { organizationId: org.id, memberId: member.id, role: newRole },
      });
      assert.equal(changed.role, newRole);
    }
    const invitation = await auth.api.createInvitation({
      headers: owner.headers,
      body: { organizationId: org.id, email: spare.email, role },
    });
    assert.equal(invitation.role, role);
    assert.ok(
      Math.abs(new Date(invitation.expiresAt).getTime() - Date.now() - 7 * 24 * 60 * 60_000) <
        5_000,
    );
    const accepted = await auth.api.acceptInvitation({
      headers: spare.headers,
      body: { invitationId: invitation.id },
    });
    assert.equal(accepted.member.role, role);
    assert.equal(db.invitation.find((row) => row.id === invitation.id).status, "accepted");
    assert.ok(added.length >= 3, "creator, added member and accepted member notify provisioning");
  });

  test(`HTTP invitations, acceptance and role changes allow single ${role}`, async () => {
    const { http, db, owner, guest, org } = await nativeAuth();
    const invited = await http(owner, "invite-member", {
      organizationId: org.id,
      email: guest.email,
      role,
    });
    assert.equal(invited.status, 200, await invited.clone().text());
    const invitation = await invited.json();
    assert.equal(invitation.role, role);
    const accepted = await http(guest, "accept-invitation", { invitationId: invitation.id });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const member = (await accepted.json()).member;
    assert.equal(member.role, role);
    for (const newRole of ["admin", "member"]) {
      const changed = await http(owner, "update-member-role", {
        organizationId: org.id,
        memberId: member.id,
        role: newRole,
      });
      assert.equal(changed.status, 200, await changed.clone().text());
      assert.equal(db.member.find((row) => row.id === member.id).role, newRole);
    }
  });
}

for (const role of rejected) {
  test(`common hooks reject direct server add, invite, accept and promotion for ${role}`, async () => {
    const { auth, db, owner, guest, spare, org } = await nativeAuth();
    await assert.rejects(
      auth.api.addMember({ body: { organizationId: org.id, userId: guest.id, role } }),
    );
    assert.equal(
      db.member.some((row) => row.userId === guest.id),
      false,
    );
    await assert.rejects(
      auth.api.createInvitation({
        headers: owner.headers,
        body: { organizationId: org.id, email: spare.email, role },
      }),
    );
    assert.equal(db.invitation.length, 0);
    const member = await auth.api.addMember({
      body: { organizationId: org.id, userId: guest.id, role: "member" },
    });
    await assert.rejects(
      auth.api.updateMemberRole({
        headers: owner.headers,
        body: { organizationId: org.id, memberId: member.id, role },
      }),
    );
    assert.equal(db.member.find((row) => row.id === member.id).role, "member");
    const invitation = await auth.api.createInvitation({
      headers: owner.headers,
      body: { organizationId: org.id, email: spare.email, role: "member" },
    });
    db.invitation.find((row) => row.id === invitation.id).role = role;
    await assert.rejects(
      auth.api.acceptInvitation({ headers: spare.headers, body: { invitationId: invitation.id } }),
    );
    assert.equal(db.invitation.find((row) => row.id === invitation.id).status, "pending");
    assert.equal(
      db.member.some((row) => row.userId === spare.id),
      false,
    );
    db.invitation.find((row) => row.id === invitation.id).role = "member";
    const accepted = await auth.api.acceptInvitation({
      headers: spare.headers,
      body: { invitationId: invitation.id },
    });
    assert.equal(accepted.member.role, "member");
  });

  test(`HTTP refuses invitation, promotion and retained invitation acceptance for ${role}`, async () => {
    const { auth, http, db, owner, guest, spare, org } = await nativeAuth();
    assert.equal(
      (await http(owner, "invite-member", { organizationId: org.id, email: spare.email, role }))
        .status,
      400,
    );
    assert.equal(db.invitation.length, 0);
    const member = await auth.api.addMember({
      body: { organizationId: org.id, userId: guest.id, role: "member" },
    });
    assert.equal(
      (
        await http(owner, "update-member-role", {
          organizationId: org.id,
          memberId: member.id,
          role,
        })
      ).status,
      400,
    );
    assert.equal(db.member.find((row) => row.id === member.id).role, "member");
    const invitation = await auth.api.createInvitation({
      headers: owner.headers,
      body: { organizationId: org.id, email: spare.email, role: "member" },
    });
    db.invitation.find((row) => row.id === invitation.id).role = role;
    assert.equal(
      (await http(spare, "accept-invitation", { invitationId: invitation.id })).status,
      400,
    );
    assert.equal(db.invitation.find((row) => row.id === invitation.id).status, "pending");
    assert.equal(
      db.member.some((row) => row.userId === spare.id),
      false,
    );
  });
}
