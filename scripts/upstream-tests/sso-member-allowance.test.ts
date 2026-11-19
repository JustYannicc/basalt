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
 * The hosted SSO plugin inside a real Better Auth instance on its memory adapter, with one team
 * holding an owner. Billing either answers an allowance or refuses as it does during an outage.
 */
const fixture = async (allowance: number | "unavailable") => {
  // The hosted auth's billing hook maps any unconfirmed allowance to this 503.
  const refusal = new APIError("SERVICE_UNAVAILABLE", {
    message: "We could not check your member allowance. Try again.",
  });
  let whileAsking = () => {};
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
        whileAsking();
        if (allowance === "unavailable") throw refusal;
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
  /** The verified connection row the native callback hands to provisioning. */
  const connection = {
    issuer: "https://idp.example.com",
    userId: owner.id,
    providerId: "sso-fixture",
    organizationId: team,
    domain: "example.com",
    domainVerified: true,
  };
  const provisionUser = plugin.options.provisionUser;
  assert.ok(provisionUser, "the hosted SSO plugin provisions membership on login");
  /** What the native SSO callback runs after the bound provider authenticated this person. */
  const signIn = (user: ReturnType<typeof person>) =>
    Promise.resolve(
      provisionUser({
        user,
        userInfo: { id: `idp-${user.id}`, email: user.email },
        provider: connection,
      }),
    );
  const memberships = (user: { readonly id: string }) =>
    db.member.filter((row) => row.organizationId === team && row.userId === user.id);
  return {
    db,
    refusal,
    asked,
    added,
    owner,
    person,
    signIn,
    memberships,
    /** Run while billing answers, as another request would between the checks. */
    meanwhile: (run: () => void) => {
      whileAsking = run;
    },
  };
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
  const { refusal, asked, added, person, signIn, memberships } = await fixture("unavailable");
  const newcomer = person("newcomer");

  await assert.rejects(signIn(newcomer), (error: unknown) => {
    assert.equal(error, refusal, "the billing refusal and its failure category reach the person");
    return true;
  });

  assert.deepEqual(asked, [team]);
  assert.equal(memberships(newcomer).length, 0, "an unconfirmed allowance admits no one");
  assert.deepEqual(added, []);
});

test("a sign-in racing a concurrent join keeps one membership", async () => {
  const room = await fixture(5);
  const racer = room.person("racer");
  // A concurrent first sign-in commits this person's membership after the early check.
  room.meanwhile(() => {
    room.db.member.push({
      id: "member_racer",
      organizationId: team,
      userId: racer.id,
      role: "member",
      createdAt: created,
    });
  });

  await room.signIn(racer);

  assert.deepEqual(room.asked, [team]);
  assert.equal(room.memberships(racer).length, 1, "the team lock checks membership again");
  assert.deepEqual(room.added, []);
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
