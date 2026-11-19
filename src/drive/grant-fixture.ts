/**
 * Grant storage as the product writes it, for drive tests: Better Auth with the hosted grant plugins
 * over the test's own PGlite database. Connections come from the grant store's own endpoint and every
 * grant from a device authorization the person approves in the browser, so each row has the shape
 * production stores. Devices connect with the Obsidian plugin's own client code. The two discovery
 * documents the hosted HTTP layer serves are the only stand-ins.
 */
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization as organizations } from "better-auth/plugins/organization";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { GrantId, mcpResource, requestedMcpAddress } from "@executor-js/mcp-auth";
import type { ConnectionId, ConnectionInput } from "@executor-js/mcp-auth/connections";
import { authOptions } from "../../.upstream/apps/hosted/server/src/implementation/auth.ts";
import { provisionHostedOAuthResources } from "../../.upstream/apps/hosted/server/src/implementation/mcp-oauth.ts";
import { beginConnection, pollConnection } from "../../clients/obsidian/auth.ts";
import type { Http } from "../../clients/obsidian/http.ts";

const origin = "http://localhost:3000",
  issuer = `${origin}/api/auth`,
  origins = { origin, issuer, resourceOrigins: { api: [origin], mcp: [origin] } };
const deviceCode = "urn:ietf:params:oauth:grant-type:device_code";
const Registered = Schema.Struct({ client_id: Schema.String });
const Started = Schema.Struct({ device_code: Schema.String, user_code: Schema.String });
const Stored = Schema.Array(Schema.Struct({ id: GrantId }));

/** Kysely over the test's SQL client, so Better Auth writes the same database the drive reads. */
const kyselyOver = (sql: SqlClient.SqlClient) => {
  const run = <R>(statement: string, parameters: readonly unknown[] = []) =>
    Effect.runPromise(sql.unsafe<R>(statement, parameters));
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => ({
      rows: [...(await run<R>(query.sql, query.parameters))],
    }),
    streamQuery: () => {
      throw new Error("Grant storage never streams");
    },
  };
  return new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        releaseConnection: async () => {},
        destroy: async () => {},
        beginTransaction: async () => void (await run("begin")),
        commitTransaction: async () => void (await run("commit")),
        rollbackTransaction: async () => void (await run("rollback")),
      }),
    },
  });
};

/** A member of `organization`, signed in to the browser, with the grant store's write paths. */
export const grantStore = (organization: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const base = authOptions({ ...origins, url: origin, oauthRedirectUri: Option.none() }, []);
    const options = {
      ...base,
      // Hosts add their own organization plugin; membership decides which grants a person may hold.
      plugins: [...base.plugins, organizations()],
      database: { db: kyselyOver(sql), type: "postgres" as const },
      secret: "fixture-only-grant-storage-secret-never-used-elsewhere",
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: false },
      logger: { disabled: true },
    };
    yield* Effect.promise(async () => (await getMigrations(options)).runMigrations());
    const auth = betterAuth(options);
    const context = yield* Effect.promise(() => auth.$context);
    yield* provisionHostedOAuthResources(origins, context);
    const email = "vault-owner@example.invalid",
      password = "fixture-vault-owner-password";
    const { user } = yield* Effect.promise(() =>
      auth.api.signUpEmail({ body: { name: "Vault owner", email, password } }),
    );
    yield* sql`update "user" set "emailVerified" = true where id = ${user.id}`;
    const signedIn = yield* Effect.promise(() =>
      auth.api.signInEmail({ asResponse: true, body: { email, password } }),
    );
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    yield* Effect.promise(async () => {
      await context.adapter.create({
        model: "organization",
        data: { id: organization, name: "Device sync", slug: "device-sync", createdAt: new Date() },
        forceAllowId: true,
      });
      await context.adapter.create({
        model: "member",
        data: {
          organizationId: organization,
          userId: user.id,
          role: "member",
          createdAt: new Date(),
        },
      });
    });
    const owner = { userId: user.id, resource: organization };
    const reply = async (response: Response, status = 200) => {
      const body = await response.text();
      assert.equal(response.status, status, body);
      const value: unknown = JSON.parse(body);
      return value;
    };
    /** The device page's Connect, in the signed-in browser. */
    const approve = async (userCode: string) =>
      reply(
        await auth.handler(
          new Request(`${issuer}/device/decide`, {
            method: "POST",
            headers: {
              origin,
              cookie,
              "content-type": "application/json",
              "x-executor-organization": organization,
            },
            body: JSON.stringify({ user_code: userCode, accept: true }),
          }),
        ),
      );
    const form = (path: string, fields: Record<string, string>) =>
      auth.handler(
        new Request(`${issuer}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
        }),
      );
    // The plugin reads discovery from the hosted HTTP layer; everything else is Better Auth's.
    const http: Http = async (url, init) => {
      const target = new URL(url);
      const document = (value: unknown) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      if (target.pathname === "/.well-known/oauth-protected-resource/mcp") {
        const address = requestedMcpAddress(new URL(`${origin}/mcp${target.search}`));
        assert.ok(address !== undefined, url);
        return document({
          resource: mcpResource(origin, address),
          authorization_servers: [issuer],
        });
      }
      if (target.pathname === "/.well-known/oauth-authorization-server/api/auth")
        return document(await auth.api.getOAuthServerConfig());
      const response = await auth.handler(new Request(url, init));
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    };
    const grantOf = (client: string) =>
      sql`select id from "mcpGrant" where "clientId" = ${client}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Stored)),
        Effect.map((rows) => {
          const [row] = rows;
          assert.ok(row !== undefined && rows.length === 1, `one grant for client ${client}`);
          return row.id;
        }),
      );
    return {
      userId: user.id,
      /** The plain MCP URL a full-access agent connects at. */
      mcpUrl: `${origin}/mcp`,
      /** A connection, as the dashboard creates it for the signed-in person, with its MCP URL. */
      connection: (input: ConnectionInput) =>
        Effect.promise(() =>
          auth.api.createMcpConnection({
            body: { ...owner, id: input.id, name: input.name, policy: { apps: input.apps } },
          }),
        ).pipe(
          Effect.map((created) => ({
            ...created,
            url: mcpResource(origin, { mode: "model", connection: created.id }),
          })),
        ),
      /** An Obsidian device connecting at a connection's URL with the plugin's code, then approved. */
      connectDevice: (connection: { readonly url: string }, device: string) =>
        Effect.promise(async () => {
          const pending = await beginConnection(http, connection.url, Date.now(), true, { device });
          await approve(pending.userCode);
          const polled = await pollConnection(http, pending);
          assert.equal(polled.state, "connected");
          return pending.clientId;
        }).pipe(Effect.flatMap(grantOf)),
      /**
       * An agent's MCP client connecting at `resource`. It registers for browser sign-in as MCP
       * clients do; a device code lets the fixture approve it without a consent page, and grant
       * storage records the same rows for either.
       */
      connectAgent: (resource: string, name: string) =>
        Effect.promise(async () => {
          const { client_id } = Schema.decodeUnknownSync(Registered)(
            await reply(
              await auth.handler(
                new Request(`${issuer}/oauth2/register`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    client_name: name,
                    token_endpoint_auth_method: "none",
                    grant_types: ["authorization_code", deviceCode, "refresh_token"],
                    response_types: ["code"],
                    redirect_uris: ["http://127.0.0.1:33418/callback"],
                    scope: "mcp offline_access",
                  }),
                }),
              ),
              201,
            ),
          );
          const started = Schema.decodeUnknownSync(Started)(
            await reply(
              await form("/oauth2/device-authorization", {
                client_id,
                scope: "mcp offline_access",
                resource,
              }),
            ),
          );
          await approve(started.user_code);
          await reply(
            await form("/oauth2/token", {
              grant_type: deviceCode,
              client_id,
              device_code: started.device_code,
            }),
          );
          return client_id;
        }).pipe(Effect.flatMap(grantOf)),
      /** Disconnect: the person revokes one grant. */
      revokeGrant: (id: GrantId) =>
        Effect.promise(() => auth.api.revokeMcpAgent({ body: { ...owner, id } })),
      /** The person revokes a connection, and with it every grant held through it. */
      revokeConnection: (id: ConnectionId) =>
        Effect.promise(() => auth.api.revokeMcpConnection({ body: { ...owner, id } })),
    };
  });
