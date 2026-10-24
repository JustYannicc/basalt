import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Redacted } from "effect";
import { createRequire } from "node:module";
import { load } from "./pool-access-fixture.ts";
const require = createRequire(
  new URL("../../.upstream/apps/hosted/cloud/package.json", import.meta.url),
);
const { betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));
const { cloudAuthOptions } = await load("apps/hosted/cloud/src/implementation/auth-options.ts");

async function nativeAuth() {
  let fail = false;
  const removing: { organization: string; member: string }[] = [];
  const deleting: string[] = [];
  const added: string[] = [];
  const access = {
    memberRemoving: async (organization: string, member: string) => {
      removing.push({ organization, member });
      if (fail) throw new Error("Pool worker unavailable");
    },
    membersAdded: async (organization: string) => {
      added.push(organization);
    },
    userDeleting: async (user: string) => {
      deleting.push(user);
      if (fail) throw new Error("Pool worker unavailable");
    },
  };
  const db: Record<string, any[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  const url = "http://localhost:3000";
  const settings = {
    url,
    issuer: `${url}/api/auth`,
    resourceOrigins: { api: [url], mcp: [url] },
    callbackOrigin: url,
    oauthRedirectUri: Option.none(),
    oauthProxy: Option.none(),
    trustedOrigins: [],
    emulators: Option.none(),
    chatGpt: Option.none(),
    googleClientId: "unused",
    googleClientSecret: Redacted.make("unused"),
    githubClientId: "unused",
    githubClientSecret: Redacted.make("unused"),
    brand: { name: "Signalbox", logo: { light: "/logo.svg", dark: "/logo.svg" }, links: {} },
    hosts: { sharedCookieDomain: Option.none(), passkey: { rpId: "localhost", origin: url } },
    rateLimitEnabled: false,
  };
  const options = cloudAuthOptions(
    settings,
    [],
    () => Effect.void,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    access,
  );
  const auth = betterAuth({
    ...options,
    secret: "fixture-only-auth-secret-never-used-outside-tests",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, autoSignIn: false },
    logger: { disabled: true },
  });
  async function signup(name: string) {
    const response = await auth.api.signUpEmail({
      asResponse: true,
      body: { name, email: `${name}@example.invalid`, password: "fixture-password-1234" },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json();
    const user = db.user.find((row) => row.id === value.user.id);
    user.emailVerified = true;
    const signedIn = await auth.api.signInEmail({
      asResponse: true,
      body: { email: user.email, password: "fixture-password-1234" },
    });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const headers = new Headers({
      cookie: signedIn.headers
        .getSetCookie()
        .map((cookie: string) => cookie.split(";")[0])
        .join("; "),
    });
    return { ...value.user, headers };
  }
  const owner = await signup("owner");
  const guest = await signup("guest");
  const spare = await signup("spare");
  const org = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Fixture", slug: "fixture" },
  });
  assert.equal(
    db.member.find((row) => row.userId === owner.id).role,
    "owner",
    "createOrganization retains its creator owner",
  );
  return {
    auth,
    db,
    owner,
    guest,
    spare,
    org,
    removing,
    deleting,
    added,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
  };
}

for (const role of ["admin", "owner", "admin,owner", "member,admin"]) {
  test(`native invite/add/update refuse ${role}; member remains allowed`, async () => {
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
    assert.equal(db.invitation?.length ?? 0, 0);
    const member = await auth.api.addMember({
      body: { organizationId: org.id, userId: guest.id, role: "member" },
    });
    assert.equal(member.role, "member");
    await assert.rejects(
      auth.api.updateMemberRole({
        headers: owner.headers,
        body: { organizationId: org.id, memberId: member.id, role },
      }),
    );
    assert.equal(db.member.find((row) => row.id === member.id).role, "member");
    const unchanged = await auth.api.updateMemberRole({
      headers: owner.headers,
      body: { organizationId: org.id, memberId: member.id, role: "member" },
    });
    assert.equal(unchanged.role, "member");
    const invitation = await auth.api.createInvitation({
      headers: owner.headers,
      body: { organizationId: org.id, email: spare.email, role: "member" },
    });
    assert.equal(invitation.role, "member");
    assert.ok(
      Math.abs(new Date(invitation.expiresAt).getTime() - Date.now() - 7 * 24 * 60 * 60_000) <
        5_000,
    );
  });
}

for (const role of ["admin", "owner"]) {
  test(`native acceptance refuses an older ${role} invitation before marking it accepted`, async () => {
    const { auth, db, owner, guest, org, added } = await nativeAuth();
    const invitation = await auth.api.createInvitation({
      headers: owner.headers,
      body: { organizationId: org.id, email: guest.email, role: "member" },
    });
    db.invitation.find((row) => row.id === invitation.id).role = role;
    await assert.rejects(
      auth.api.acceptInvitation({ headers: guest.headers, body: { invitationId: invitation.id } }),
    );
    assert.equal(db.invitation.find((row) => row.id === invitation.id).status, "pending");
    assert.equal(
      db.member.some((row) => row.userId === guest.id),
      false,
    );
    db.invitation.find((row) => row.id === invitation.id).role = "member";
    const accepted = await auth.api.acceptInvitation({
      headers: guest.headers,
      body: { invitationId: invitation.id },
    });
    assert.equal(accepted.member.role, "member");
    assert.ok(added.length >= 2, "creator and accepted member both notify provisioning");
  });
}

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
