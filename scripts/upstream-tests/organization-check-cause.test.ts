import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect, Layer, Logger, Option, Redacted, References } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient, type SqlError } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { load } from "./pool-access-fixture.ts";

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
// Typed, so the root type check covers the check and the decision it maps.
const {
  organizationCreationCheck,
}: typeof import("../../.upstream/apps/hosted/cloud/src/implementation/organization-check.ts") =
  await load("apps/hosted/cloud/src/implementation/organization-check.ts");
const {
  makeOnboarding,
}: typeof import("../../.upstream/apps/hosted/cloud/src/implementation/onboarding.ts") = await load(
  "apps/hosted/cloud/src/implementation/onboarding.ts",
);
const { companyLookupDisabled } = await load(
  "apps/hosted/cloud/src/implementation/company-profile.ts",
);
const { v1MembershipLive } = await load("apps/hosted/cloud/src/implementation/v1-membership.ts");
const { migrateOnboarding } = await load("apps/hosted/cloud/src/implementation/migrations.ts");
const { BlobStore } = await load("packages/sdk/src/core.ts");
const { memoryBlobStore } = await load("packages/sdk/src/implementation/memory-blobs.ts");

const url = "http://localhost:3000";
const password = "fixture-password-1234";

/** A loopback port that was just released, so the v1 lookup's connection is refused. */
const closedPort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
};

interface Logged {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/**
 * Better Auth's own organization endpoint on an embedded database, with the cloud's create check:
 * the real onboarding decision and the real v1 lookup, pointed at a port that refuses connections.
 */
const organizationEndpoint = (
  run: (fixture: {
    readonly sql: SqlClient.SqlClient;
    readonly logs: ReadonlyArray<Logged>;
    readonly signIn: (
      email: string,
      verified: boolean,
    ) => Effect.Effect<Headers, SqlError.SqlError>;
    readonly create: (headers: Headers, slug: string) => Effect.Effect<Response>;
  }) => Effect.Effect<void, SqlError.SqlError>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pg = (yield* PgliteClient).pglite;
        const connection = {
          executeQuery: async (query: { sql: string; parameters: ReadonlyArray<unknown> }) => {
            const result = await pg.query(query.sql, [...query.parameters], {
              parsers: { 1114: (value: string) => new Date(`${value.replace(" ", "T")}Z`) },
            });
            return { rows: result.rows, numAffectedRows: BigInt(result.affectedRows ?? 0) };
          },
          async *streamQuery() {
            throw new Error("The organization check fixture does not stream SQL");
          },
        };
        const database = new Kysely({
          dialect: {
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (db: unknown) => new PostgresIntrospector(db),
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
        const logs: Logged[] = [];
        const capture = Logger.make(({ message, fiber }) => {
          logs.push({
            message: Array.isArray(message) ? message[0] : message,
            annotations: fiber.getRef(References.CurrentLogAnnotations),
          });
        });
        const v1 = v1MembershipLive({
          baseUrl: `http://127.0.0.1:${yield* Effect.promise(closedPort)}`,
          key: Redacted.make("fixture-only-v1-key"),
          since: new Date(0),
          database: Redacted.make("postgres://fixture.invalid/v1"),
        });
        const onboarding = yield* makeOnboarding({ origin: url }).pipe(
          Effect.provideService(BlobStore, memoryBlobStore()),
          Effect.provide(Layer.mergeAll(companyLookupDisabled, v1)),
          Effect.provide(FetchHttpClient.layer),
        );
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
          undefined,
          undefined,
          undefined,
          undefined,
          // The cloud runs this check in the calling request's runtime; here the log is captured.
          (userId: string) =>
            Effect.runPromise(
              organizationCreationCheck(onboarding, userId).pipe(
                Effect.provide(Logger.layer([capture])),
              ),
            ),
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
        yield* migrateOnboarding;
        const auth = betterAuth(options);
        const signIn = (email: string, verified: boolean) =>
          Effect.gen(function* () {
            const signed = yield* Effect.promise<{ readonly user: { readonly id: string } }>(() =>
              auth.api.signUpEmail({ body: { name: "Fixture Person", email, password } }),
            );
            yield* sql`update "user" set "emailVerified" = true where id = ${signed.user.id}`;
            const response = yield* Effect.promise<Response>(() =>
              auth.api.signInEmail({ asResponse: true, body: { email, password } }),
            );
            assert.equal(response.status, 200, yield* Effect.promise(() => response.text()));
            // Cloud password sign-in needs a verified email; the session outlives a later change.
            if (!verified)
              yield* sql`update "user" set "emailVerified" = false where id = ${signed.user.id}`;
            return new Headers({
              cookie: response.headers
                .getSetCookie()
                .map((cookie) => cookie.split(";")[0])
                .join("; "),
            });
          });
        const create = (headers: Headers, slug: string) =>
          Effect.promise<Response>(() =>
            auth.handler(
              new Request(`${url}/api/auth/organization/create`, {
                method: "POST",
                headers: {
                  cookie: headers.get("cookie") ?? "",
                  origin: url,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  name: "Fixture team",
                  slug,
                  keepCurrentActiveOrganization: true,
                }),
              }),
            ),
          );
        yield* run({ sql, logs, signIn, create });
      }),
    ).pipe(Effect.provide(pgliteLayer())) as Effect.Effect<void, SqlError.SqlError>,
  );

const reasons = (logs: ReadonlyArray<Logged>) =>
  logs.flatMap((log) =>
    typeof log.annotations["onboarding.check.reason"] === "string"
      ? [log.annotations["onboarding.check.reason"]]
      : [],
  );

test("an unverified email is told to verify it, not to retry", async () => {
  await organizationEndpoint(({ sql, logs, signIn, create }) =>
    Effect.gen(function* () {
      const headers = yield* signIn("unverified@example.invalid", false);
      const response = yield* create(headers, "unverified-team");
      const body = yield* Effect.promise(() => response.json());
      assert.equal(response.status, 403, JSON.stringify(body));
      assert.equal(body.code, "EMAIL_NOT_VERIFIED");
      assert.match(body.message, /verify your email/i);
      assert.doesNotMatch(body.message, /try again/i);
      assert.deepEqual(reasons(logs), ["email_unverified"]);
      assert.equal((yield* sql`select id from organization`).length, 0);
    }),
  );
});

test("an unreachable v1 lookup stays the retryable 503 and the log names the lookup", async () => {
  await organizationEndpoint(({ sql, logs, signIn, create }) =>
    Effect.gen(function* () {
      const headers = yield* signIn("verified@example.invalid", true);
      const response = yield* create(headers, "verified-team");
      const body = yield* Effect.promise(() => response.json());
      assert.equal(response.status, 503, JSON.stringify(body));
      assert.equal(body.code, "ORGANIZATION_CHECK_UNAVAILABLE");
      assert.equal(body.message, "We could not check your account. Try again.");
      assert.deepEqual(reasons(logs), ["v1_lookup"]);
      // Neither the email nor the account id reaches the log.
      const logged = JSON.stringify(logs);
      assert.doesNotMatch(logged, /verified@example\.invalid/);
      assert.equal((yield* sql`select id from organization`).length, 0);
    }),
  );
});
