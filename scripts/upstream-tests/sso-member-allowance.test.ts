import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuth } from "../../.upstream/apps/hosted/cloud/node_modules/better-auth/dist/index.mjs";
import { memoryAdapter } from "../../.upstream/apps/hosted/cloud/node_modules/better-auth/dist/adapters/memory-adapter/index.mjs";
import { APIError } from "../../.upstream/apps/hosted/cloud/node_modules/better-auth/dist/api/index.mjs";
import { organization } from "../../.upstream/apps/hosted/cloud/node_modules/better-auth/dist/plugins/organization/index.mjs";
import { cloudSso } from "../../.upstream/apps/hosted/cloud/src/implementation/sso.ts";

const team = "org_fixture";
const created = new Date("2026-11-01T00:00:00.000Z");

/**
 * The refusal the hosted auth's billing hook raises when the allowance cannot be confirmed: a
 * 503 with the safe failure category and the reference its server log carries.
 */
const allowanceUnavailable = () =>
  new APIError("SERVICE_UNAVAILABLE", {
    message: "We could not check your member allowance. Try again.",
    code: "MEMBER_ALLOWANCE_UNAVAILABLE",
    operation: "getCustomer",
    reason: "unavailable",
    providerStatus: 503,
    reference: "ref-fixture",
  });

/**
 * The hosted SSO plugin inside a real Better Auth instance on its memory adapter, with one team
 * holding an owner. Billing either answers an allowance or refuses as it does during an outage.
 */
const fixture = async (allowance: number | "unavailable") => {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [{ id: team, name: "Fixture", slug: "fixture", createdAt: created }],
    member: [],
    invitation: [],
    ssoProvider: [],
  };
  const asked: string[] = [];
  const added: string[] = [];
  const plugin = cloudSso(
    {
      memberLimit: async (organizationId) => {
        asked.push(organizationId);
        if (allowance === "unavailable") throw allowanceUnavailable();
        return allowance;
      },
    },
    {
      memberRemoving: async () => {},
      membersAdded: async (organizationId) => {
        added.push(organizationId);
      },
      userDeleting: async () => {},
    },
  );
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "fixture-only-sso-auth-secret-never-used-outside-tests",
    database: memoryAdapter(db),
    plugins: [organization(), plugin],
    rateLimit: { enabled: false },
    logger: { disabled: true },
  });
  await auth.$context;
  const person = (name: string) => {
    const user = {
      id: `user_${name}`,
      name,
      email: `${name}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: created,
      updatedAt: created,
    };
    db.user.push(user);
    return user;
  };
  const owner = person("owner");
  db.member.push({
    id: "member_owner",
    organizationId: team,
    userId: owner.id,
    role: "owner",
    createdAt: created,
  });
  const provisionUser = plugin.options.provisionUser;
  assert.ok(provisionUser, "the hosted SSO plugin provisions membership on login");
  /** What the native SSO callback runs after the bound provider authenticated this person. */
  const signIn = (user: ReturnType<typeof person>) =>
    Promise.resolve(
      provisionUser({
        user,
        userInfo: { id: `idp-${user.id}`, email: user.email },
        provider: {
          issuer: "https://idp.example.com",
          userId: owner.id,
          providerId: "sso-fixture",
          organizationId: team,
          domain: "example.com",
          domainVerified: true,
        },
      }),
    );
  const memberships = (user: { readonly id: string }) =>
    db.member.filter((row) => row.organizationId === team && row.userId === user.id);
  return { db, asked, added, owner, person, signIn, memberships };
};

test("an existing member signs in with SSO while billing is unavailable", async () => {
  const { db, asked, added, person, signIn, memberships } = await fixture("unavailable");
  const member = person("member");
  db.member.push({
    id: "member_existing",
    organizationId: team,
    userId: member.id,
    role: "member",
    createdAt: created,
  });

  await assert.doesNotReject(signIn(member));

  assert.deepEqual(asked, [], "signing in adds no one, so the allowance is never asked");
  assert.equal(memberships(member).length, 1);
  assert.deepEqual(added, []);
});

test("an invited person signs in with SSO while billing is unavailable", async () => {
  const { db, asked, added, owner, person, signIn, memberships } = await fixture("unavailable");
  const invitee = person("invitee");
  db.invitation.push({
    id: "invitation_pending",
    organizationId: team,
    email: invitee.email,
    role: "admin",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    inviterId: owner.id,
    createdAt: created,
  });

  await assert.doesNotReject(signIn(invitee));

  assert.deepEqual(asked, [], "the invitation owns the membership, so SSO adds no one");
  assert.equal(memberships(invitee).length, 0, "the invitation must still be accepted");
  assert.deepEqual(added, []);
});

test("a new member's SSO sign-in fails closed while billing is unavailable", async () => {
  const { asked, added, person, signIn, memberships } = await fixture("unavailable");
  const newcomer = person("newcomer");

  await assert.rejects(signIn(newcomer), (error: unknown) => {
    assert.ok(error instanceof APIError);
    assert.equal(error.status, "SERVICE_UNAVAILABLE");
    assert.equal(error.body?.code, "MEMBER_ALLOWANCE_UNAVAILABLE");
    assert.equal(error.body?.reference, "ref-fixture");
    return true;
  });

  assert.deepEqual(asked, [team]);
  assert.equal(memberships(newcomer).length, 0, "an unconfirmed allowance admits no one");
  assert.deepEqual(added, []);
});

test("a new member joins through SSO within the allowance and is refused beyond it", async () => {
  const room = await fixture(2);
  const first = room.person("first");
  await room.signIn(first);
  assert.deepEqual(room.asked, [team]);
  assert.equal(room.memberships(first).length, 1);
  assert.deepEqual(room.added, [team]);

  const full = await fixture(1);
  const second = full.person("second");
  await assert.rejects(full.signIn(second), (error: unknown) => {
    assert.ok(error instanceof APIError);
    assert.equal(error.status, "FORBIDDEN");
    return true;
  });
  assert.deepEqual(full.asked, [team]);
  assert.equal(full.memberships(second).length, 0);
  assert.deepEqual(full.added, []);
});
