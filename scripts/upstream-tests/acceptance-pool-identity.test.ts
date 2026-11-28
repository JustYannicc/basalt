import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  AcceptancePoolRefused,
  acceptanceIdentity,
} from "../../.upstream/apps/hosted/server/src/contracts/acceptance-pool.ts";
import { queuePoolAppUpgrades } from "../../.upstream/apps/hosted/server/src/implementation/pool-app-upgrades.ts";
import { seatReconcileCandidates } from "../../.upstream/apps/hosted/cloud/src/implementation/billing-seats.ts";
import {
  ensureIdentity,
  inspectIdentity,
  verifyIdentity,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/identity.ts";
import { cloudAuthOptions } from "../../.upstream/apps/hosted/cloud/src/implementation/auth-options.ts";
import { identitySchema as schema } from "./acceptance-pool-fixture.ts";

const require = createRequire(
  new URL("../../.upstream/apps/hosted/cloud/package.json", import.meta.url),
);
const { betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));

const refusal = (error: unknown) => {
  assert.ok(error instanceof AcceptancePoolRefused, `expected a refusal, got ${String(error)}`);
  return error.reason;
};

const pglite = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(body.pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeCrypto.layer)));

const identityRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`select (select count(*) from "user" where id = 'acceptance')::int as users,
    (select count(*) from organization where id = 'acceptance')::int as organizations,
    (select count(*) from member where id = 'acceptance-owner')::int as members,
    (select count(*) from hosted_provisioning)::int as jobs,
    (select count(*) from cloud_welcome_email)::int as welcome`,
);

test("ensure-identity writes the three rows once, and nothing its triggers queued survives the commit", () =>
  pglite(
    Effect.gen(function* () {
      yield* schema;
      const observed = yield* inspectIdentity;
      assert.deepEqual(Object.values(observed), ["absent", "absent", "absent"]);
      const first = yield* ensureIdentity;
      assert.deepEqual(first.inserted, ["user", "organization", "member"]);
      assert.deepEqual(yield* identityRows, [
        { users: 1, organizations: 1, members: 1, jobs: 0, welcome: 0 },
      ]);
      const second = yield* ensureIdentity;
      assert.deepEqual(second.inserted, [], "a repeat writes nothing");
      assert.notDeepEqual(Object.values(yield* inspectIdentity), ["absent", "absent", "absent"]);
      assert.deepEqual(yield* verifyIdentity, {
        identityRows: true,
        identityInert: true,
        noWelcomeEmail: true,
        noBillingSeats: true,
      });
    }),
  ));

test("ensure-identity refuses every shape that is not an inert identity, and writes nothing", async () => {
  const shapes: Record<string, string> = {
    "a user with other bytes": `insert into "user" (id, name, email, "emailVerified") values ('acceptance', 'Someone', 'acceptance@basalt.invalid', true)`,
    "the email taken": `insert into "user" (id, name, email, "emailVerified") values ('person', 'P', 'ACCEPTANCE@basalt.invalid', true)`,
    "the slug taken": `insert into organization (id, name, slug) values ('team', 'Team', 'acceptance')`,
    "a password": `insert into account values ('a1', 'acceptance')`,
    "a session": `insert into session values ('s1', 'acceptance')`,
    "an API key": `insert into apikey values ('k1', 'acceptance')`,
    "a passkey": `insert into passkey values ('p1', 'acceptance')`,
    "an invitation": `insert into invitation values ('i1', 'acceptance')`,
    "a removal": `insert into hosted_organization_removal values ('acceptance')`,
  };
  for (const [shape, statement] of Object.entries(shapes))
    await pglite(
      Effect.gen(function* () {
        const sql = yield* schema;
        yield* sql.unsafe(statement);
        const before = yield* identityRows;
        assert.equal(refusal(yield* Effect.flip(inspectIdentity)), "identity_conflict", shape);
        assert.equal(refusal(yield* Effect.flip(ensureIdentity)), "identity_conflict", shape);
        assert.deepEqual(yield* identityRows, before, `${shape}: nothing written`);
      }),
    );
  await pglite(
    Effect.gen(function* () {
      const sql = yield* schema;
      yield* ensureIdentity;
      yield* sql`insert into "user" (id, name, email, "emailVerified") values ('person', 'P', 'p@example.invalid', true)`;
      yield* sql`insert into member (id, "organizationId", "userId", role) values ('m2', 'acceptance', 'person', 'member')`;
      assert.equal(
        refusal(yield* Effect.flip(ensureIdentity)),
        "identity_conflict",
        "another member",
      );
      yield* sql`delete from member where id = 'm2'`;
      yield* sql`delete from hosted_provisioning`;
      yield* sql`insert into organization (id, name, slug) values ('team', 'Team', 'team')`;
      yield* sql`insert into member (id, "organizationId", "userId", role) values ('m3', 'team', 'acceptance', 'member')`;
      assert.equal(
        refusal(yield* Effect.flip(ensureIdentity)),
        "identity_conflict",
        "another membership",
      );
      yield* sql`delete from member where id = 'm3'`;
      yield* sql`delete from hosted_provisioning`;
      yield* sql`insert into hosted_provisioning (kind, organization_id) values ('billing', 'acceptance')`;
      assert.equal(
        refusal(yield* Effect.flip(ensureIdentity)),
        "identity_conflict",
        "a waiting job",
      );
      yield* sql`delete from hosted_provisioning`;
      yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
        values ('basalt-pool-access:app_one', 'member', 'acceptance', 'acceptance')`;
      assert.deepEqual(
        (yield* ensureIdentity).inserted,
        [],
        "the pool's own access job is not a conflict",
      );
    }),
  );
});

test("the identity is never a seat-reconcile candidate, while a person's organization still is", () =>
  pglite(
    Effect.gen(function* () {
      const sql = yield* schema;
      yield* ensureIdentity;
      yield* sql`insert into organization (id, name, slug) values ('team', 'Team', 'team')`;
      const candidates = (yield* seatReconcileCandidates).map((row) => row.organization);
      assert.deepEqual(candidates, ["team"]);
    }),
  ));

test("release rollouts queue no member job for the identity, and still queue one for a person", () =>
  pglite(
    Effect.gen(function* () {
      const sql = yield* schema;
      yield* ensureIdentity;
      yield* sql`insert into "user" (id, name, email, "emailVerified") values ('person', 'P', 'p@example.invalid', true)`;
      yield* sql`insert into organization (id, name, slug, metadata) values ('team', 'Team', 'team',
        ${JSON.stringify({ basaltPools: { app_person: { owner: "person", tokenKeyVersion: "old" } } })})`;
      yield* sql`update organization set metadata = ${JSON.stringify({
        basaltPools: { app_acceptance: { owner: "acceptance", tokenKeyVersion: "old" } },
      })} where id = 'acceptance'`;
      yield* sql`insert into member (id, "organizationId", "userId", role) values ('m1', 'team', 'person', 'owner')`;
      yield* sql`delete from hosted_provisioning`;
      yield* queuePoolAppUpgrades(Redacted.make("ab".repeat(32)), "bundle-1");
      const jobs = yield* sql<{
        user_id: string;
        organization_id: string;
      }>`select user_id, organization_id
        from hosted_provisioning order by id`;
      assert.ok(jobs.length >= 2, "the person's pool gets its rotation and bundle jobs");
      assert.ok(jobs.every((job) => job.user_id === "person" && job.organization_id === "team"));
    }),
  ));

test("no sign-in method opens a session for the identity, and no account can be added to it", async () => {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  const url = "http://localhost:3000";
  const options = cloudAuthOptions(
    {
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
    } as never,
    [],
    () => Effect.void,
  );
  let nextUser: string | undefined;
  const auth = betterAuth({
    ...options,
    // Fixed user ids, so the control and the identity differ in nothing but the id.
    advanced: {
      ...options.advanced,
      database: {
        generateId: ({ model }: { model: string }) =>
          model === "user" && nextUser !== undefined ? nextUser : crypto.randomUUID(),
      },
    },
    secret: "fixture-only-auth-secret-never-used-outside-tests",
    rateLimit: { enabled: false },
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, autoSignIn: false },
    logger: { disabled: true },
  });
  const signUp = (id: string, email: string) => {
    nextUser = id;
    return auth.api
      .signUpEmail({
        asResponse: true,
        body: { name: "Fixture", email, password: "fixture-password-1234" },
      })
      .finally(() => {
        nextUser = undefined;
      });
  };
  const signIn = (email: string) =>
    auth.api.signInEmail({ asResponse: true, body: { email, password: "fixture-password-1234" } });
  const verified = (id: string) => {
    const user = db.user!.find((row) => row.id === id);
    assert.ok(user, id);
    user.emailVerified = true;
  };
  assert.equal((await signUp("control-user", "control@example.invalid")).status, 200);
  verified("control-user");
  assert.equal((await signIn("control@example.invalid")).status, 200, "a fixed-id person signs in");

  // No password can be added: the account hook refuses the identity's credential.
  const added = await signUp(acceptanceIdentity.user, acceptanceIdentity.email);
  assert.notEqual(added.status, 200);
  assert.equal(db.account!.filter((row) => row.userId === acceptanceIdentity.user).length, 0);
  const context = await auth.$context;
  await assert.rejects(
    context.internalAdapter.createAccount({
      userId: acceptanceIdentity.user,
      providerId: "google",
      accountId: "google-account",
    }),
  );
  assert.equal(db.account!.filter((row) => row.userId === acceptanceIdentity.user).length, 0);

  // Were a password ever written around the hooks, the session hook still refuses it.
  const control = db.account!.find((row) => row.userId === "control-user");
  assert.ok(control);
  if (!db.user!.some((row) => row.id === acceptanceIdentity.user))
    db.user!.push({
      ...db.user!.find((row) => row.id === "control-user")!,
      id: acceptanceIdentity.user,
      email: acceptanceIdentity.email,
    });
  verified(acceptanceIdentity.user);
  db.account!.push({ ...control, id: "copied-credential", userId: acceptanceIdentity.user });
  const refused = await signIn(acceptanceIdentity.email);
  assert.notEqual(refused.status, 200);
  assert.equal(db.session!.filter((row) => row.userId === acceptanceIdentity.user).length, 0);
});
