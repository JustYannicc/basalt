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

for (const host of ["cloud", "self-host"] as const) {
  for (const role of ["admin", "member"]) {
    test(`${host}: direct server add, invite, accept and promotion allow single ${role}`, async () => {
      const { auth, http, db, owner, guest, spare, org, added, sent } = await nativeAuth(host);
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
        Math.abs(
          new Date(invitation.expiresAt).getTime() -
            Date.now() -
            (host === "cloud" ? 7 : 2) * 24 * 60 * 60_000,
        ) < 5_000,
      );
      const emails = sent.length;
      const resent = await auth.api.createInvitation({
        headers: owner.headers,
        body: { organizationId: org.id, email: spare.email, role, resend: true },
      });
      assert.equal(resent.id, invitation.id);
      assert.equal(resent.role, role);
      const response = await http(owner, "invite-member", {
        organizationId: org.id,
        email: spare.email,
        role,
        resend: true,
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).id, invitation.id);
      assert.equal(sent.length - emails, host === "cloud" ? 2 : 0);
      const accepted = await auth.api.acceptInvitation({
        headers: spare.headers,
        body: { invitationId: invitation.id },
      });
      assert.equal(accepted.member.role, role);
      assert.equal(db.invitation.find((row) => row.id === invitation.id).status, "accepted");
      if (host === "cloud")
        assert.ok(
          added.length >= 3,
          "creator, added member and accepted member notify provisioning",
        );
    });

    test(`${host}: HTTP invitations, acceptance and role changes allow single ${role}`, async () => {
      const { http, db, owner, guest, org } = await nativeAuth(host);
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
    test(`${host}: common hooks reject direct server add, invite, accept and promotion for ${role}`, async () => {
      const { auth, db, owner, guest, spare, org } = await nativeAuth(host);
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
        auth.api.acceptInvitation({
          headers: spare.headers,
          body: { invitationId: invitation.id },
        }),
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

    test(`${host}: direct and HTTP resends refuse ${role} before writes or email`, async () => {
      const { auth, http, db, owner, spare, org, sent } = await nativeAuth(host);
      const invitation = await auth.api.createInvitation({
        headers: owner.headers,
        body: { organizationId: org.id, email: spare.email, role: "member" },
      });
      const row = db.invitation.find((item) => item.id === invitation.id);
      row.expiresAt = new Date(Date.now() + 60_000);
      const before = structuredClone(row);
      const emails = sent.length;
      await assert.rejects(
        auth.api.createInvitation({
          headers: owner.headers,
          body: { organizationId: org.id, email: spare.email, role, resend: true },
        }),
      );
      assert.deepEqual(db.invitation, [before]);
      assert.equal(sent.length, emails);
      assert.equal(
        (
          await http(owner, "invite-member", {
            organizationId: org.id,
            email: spare.email,
            role,
            resend: true,
          })
        ).status,
        400,
      );
      assert.deepEqual(db.invitation, [before]);
      assert.equal(sent.length, emails);
    });

    test(`${host}: HTTP refuses invitation, promotion and retained invitation acceptance for ${role}`, async () => {
      const { auth, http, db, owner, guest, spare, org } = await nativeAuth(host);
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
}
