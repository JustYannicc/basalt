import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Effect, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { load, implementation } from "./pool-access-fixture.ts";
const require = createRequire(
  new URL("../../.upstream/apps/hosted/cloud/package.json", import.meta.url),
);
const { betterAuth } = await import(require.resolve("better-auth"));
const { getMigrations } = await import(require.resolve("better-auth/db/migration"));
const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = await import(
  require.resolve("kysely")
);
const sqlRequire = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const { PgliteClient } = await import(sqlRequire.resolve("@effect/sql-pglite/PgliteClient"));
const { cloudAuthOptions } = await load("apps/hosted/cloud/src/implementation/auth-options.ts");
const { makeOnboarding } = await load("apps/hosted/cloud/src/implementation/onboarding.ts");
const { CompanyLookup, V1Membership } = await load("apps/hosted/cloud/src/contracts/onboarding.ts");
const { BlobStore } = await load("packages/sdk/src/core.ts");
const { migrateOnboarding } = await load("apps/hosted/cloud/src/implementation/migrations.ts");
const { migrateProvisioning } = await load(`${implementation}provisioning-schema.ts`);
const { provision, ProvisioningFailed, selfHostProvisioningServices } = await load(
  `${implementation}provisioning.ts`,
);
const { OrganizationDefaults } = await load(
  "apps/hosted/server/src/contracts/organization-defaults.ts",
);

/** Native Better Auth invitation endpoints and PostgreSQL triggers share this embedded database. */
export const personalOrgFixture = (run: (f: any) => Effect.Effect<unknown, unknown, any>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pg = (yield* PgliteClient).pglite;
        const connection = {
          executeQuery: async (query: any) => {
            const result = await pg.query(query.sql, [...query.parameters], {
              parsers: { 1114: (value: string) => new Date(`${value.replace(" ", "T")}Z`) },
            });
            return { rows: result.rows, numAffectedRows: BigInt(result.affectedRows ?? 0) };
          },
          async *streamQuery() {
            throw new Error("No streaming in auth fixture");
          },
        };
        const database = new Kysely({
          dialect: {
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (db: any) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
            createDriver: () => ({
              init: async () => {},
              acquireConnection: async () => connection,
              releaseConnection: async () => {},
              destroy: async () => {},
              beginTransaction: async () => {
                await pg.exec("begin");
              },
              commitTransaction: async () => {
                await pg.exec("commit");
              },
              rollbackTransaction: async () => {
                await pg.exec("rollback");
              },
            }),
          },
        });
        const url = "http://localhost:3000";
        let v1: "continue" | "v1" | "unavailable" = "continue";
        let checks = 0;
        let seatChecks = 0;
        const base = cloudAuthOptions(
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
            brand: {
              name: "Signalbox",
              logo: { light: "/logo.svg", dark: "/logo.svg" },
              links: {},
            },
            hosts: {
              sharedCookieDomain: Option.none(),
              passkey: { rpId: "localhost", origin: url },
            },
            rateLimitEnabled: false,
          },
          [],
          () => Effect.void,
          {
            memberLimit: async () => {
              seatChecks++;
              return 10;
            },
          },
        );
        const options = {
          ...base,
          secret: "fixture-only-auth-secret-never-used-outside-tests",
          database: { db: database, type: "postgres", transaction: true },
          emailAndPassword: { enabled: true, autoSignIn: false },
          logger: { disabled: true },
          advanced: { ...base.advanced, database: { validateSchema: false } },
        };
        yield* Effect.promise(async () => {
          await (await getMigrations(options)).runMigrations();
        });
        yield* sql`create table hosted_organization_removal (organization_id text primary key)`;
        yield* migrateOnboarding;
        yield* migrateProvisioning;
        const onboarding = yield* makeOnboarding({ origin: url }).pipe(
          Effect.provideService(BlobStore, {}),
          Effect.provideService(CompanyLookup, { lookup: () => Effect.succeed(undefined) }),
          Effect.provideService(V1Membership, {
            check: () =>
              Effect.suspend(() => {
                checks++;
                return v1 === "unavailable"
                  ? Effect.fail(new Error("v1 unavailable"))
                  : Effect.succeed(v1);
              }),
          }),
        );
        const auth = betterAuth(options);
        const signup = (name: string, email: string) =>
          Effect.promise(async () => {
            const signed = await auth.api.signUpEmail({
              body: { name, email, password: "fixture-password-1234" },
            });
            await Effect.runPromise(
              sql`update "user" set "emailVerified" = true where id = ${signed.user.id}`,
            );
            const response = await auth.api.signInEmail({
              asResponse: true,
              body: { email, password: "fixture-password-1234" },
            });
            assert.equal(response.status, 200, await response.clone().text());
            return {
              ...signed.user,
              headers: new Headers({
                cookie: response.headers
                  .getSetCookie()
                  .map((c: string) => c.split(";")[0])
                  .join("; "),
              }),
            };
          });
        const owner = yield* signup("Owner", "owner@example.invalid");
        const guest = yield* signup("Guest Person", "guest@example.invalid");
        const org: any = yield* Effect.promise(() =>
          auth.api.createOrganization({
            headers: owner.headers,
            body: { name: "Shared", slug: "shared" },
          }),
        );
        const accept = () =>
          Effect.promise(async () => {
            const invitation = await auth.api.createInvitation({
              headers: owner.headers,
              body: { organizationId: org.id, email: guest.email, role: "member" },
            });
            return await auth.api.acceptInvitation({
              headers: guest.headers,
              body: { invitationId: invitation.id },
            });
          });
        const jobs = () =>
          sql`select id from hosted_provisioning where kind = 'member' and user_id = ${guest.id} and organization_id = ${org.id} order by id`;
        const work = (id: string) =>
          provision(id, {
            ...selfHostProvisioningServices,
            requireVerifiedEmail: true,
            member: (user: string) =>
              onboarding
                .ensurePersonalOrganization(user)
                .pipe(Effect.mapError(() => new ProvisioningFailed())),
          }).pipe(Effect.provideService(OrganizationDefaults, () => Effect.void));
        yield* run({
          sql,
          auth,
          owner,
          guest,
          org,
          signup,
          accept,
          jobs,
          work,
          onboarding,
          setV1: (value: typeof v1) => {
            v1 = value;
          },
          checks: () => checks,
          seatChecks: () => seatChecks,
        });
      }),
    ).pipe(Effect.provide(pgliteLayer())) as Effect.Effect<unknown, unknown, never>,
  );
