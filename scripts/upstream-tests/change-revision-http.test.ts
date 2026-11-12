import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Queue, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { singleResourceOrigin } from "../../.upstream/packages/mcp-auth/src/index.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  Authentication,
  ApiAuthentication,
  Principal,
  Unauthorized,
} from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { OrganizationId } from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import {
  makeChangeRevisionHandler,
  changeRevisionsPath,
} from "../../.upstream/apps/hosted/server/src/implementation/change-revision-http.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import type { RevisionEvent } from "../../.upstream/packages/app-data/src/contracts/change-revisions.ts";

const organization = OrganizationId.make("team-a");
const principal = Principal.make({
  userId: Principal.fields.userId.make("viewer-a"),
  sessionId: Principal.fields.sessionId.make("session-a"),
  name: "Viewer",
});
const key = { topic: "deployment", resource: "app_a" };
const initial = {
  kind: "current",
  revisions: [{ ...key, revision: "0" }],
  snapshotRequired: true,
} as const;
const origin = "https://changes.example.test";
const resourceOrigins = singleResourceOrigin(origin);

for (const revoked of ["session", "membership", "sharing"] as const) {
  test(`the public SSE route sends no private hint after ${revoked} is revoked`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of [
          "create table executor_apps (id text primary key, owner text not null, active_deployment text)",
          'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
          "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
          "create table hosted_app_groups (app_id text, group_id text)",
          "create table hosted_group_members (group_id text, member_id text)",
        ])
          yield* sql.unsafe(statement);
        yield* migrateChangeRevisions;
        yield* sql`insert into executor_apps values ('app_a','organization:team-a','build-1')`;
        yield* sql`insert into member values ('member-a','team-a','viewer-a','member')`;
        yield* sql`insert into hosted_app_access values ('app_a','team-a','other-viewer','everyone','access-1')`;
        let signedIn = true;
        let subscriptions = 0;
        const hints = yield* Queue.make<RevisionEvent>();
        const auth = Authentication.of({
          origin,
          resourceOrigins,
          current: () => Effect.sync(() => (signedIn ? principal : null)),
          membership: () => Effect.succeed({ role: "member" }),
          organization: () => Effect.succeed(organization),
          organizationSlug: () => Effect.succeed("team-a"),
          removeOrganization: () => Effect.die("unused fixture operation"),
        });
        const route = HttpRouter.add(
          "GET",
          changeRevisionsPath,
          makeChangeRevisionHandler((scope, keys) => {
            assert.equal(scope, "organization:team-a");
            assert.deepEqual(keys, [key]);
            subscriptions++;
            return Stream.make(initial).pipe(Stream.concat(Stream.fromQueue(hints)));
          }),
        ).pipe(
          HttpRouter.provideRequest(
            Layer.mergeAll(
              Layer.succeed(Authentication, auth),
              Layer.succeed(ApiAuthentication, {
                origin,
                resourceOrigins,
                issuer: origin,
                authenticate: () => Effect.fail(new Unauthorized()),
              }),
              Layer.succeed(GroupDatabase, Effect.succeed(sql)),
            ),
          ),
          Layer.provide(HttpServer.layerServices),
        );
        yield* Effect.tryPromise(async () => {
          const server = HttpRouter.toWebHandler(route, { disableLogger: true });
          try {
            const path = `${origin}/api/organizations/team-a/apps/app_a/changes`;
            assert.equal(
              (await server.handler(new Request(`${path}?topics=credentials`))).status,
              400,
            );
            assert.equal(subscriptions, 0);
            assert.equal(
              (
                await server.handler(
                  new Request(path, { headers: { authorization: "Bearer fixture-denied" } }),
                )
              ).status,
              401,
            );
            assert.equal(subscriptions, 0);
            const response = await server.handler(new Request(path));
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("cache-control"), "private, no-store");
            const reader = response.body!.getReader();
            try {
              // The SQL head is ahead of the notification owner's first message.
              assert.equal(
                new TextDecoder().decode((await reader.read()).value),
                `event: current\ndata: ${JSON.stringify({ ...initial, revisions: [{ ...key, revision: "1" }] })}\n\n`,
              );
              if (revoked === "session") signedIn = false;
              if (revoked === "membership") await Effect.runPromise(sql`delete from member`);
              if (revoked === "sharing")
                await Effect.runPromise(sql`update hosted_app_access set audience = 'private'`);
              await Effect.runPromise(
                Queue.offer(hints, { kind: "changed", hint: { ...key, revision: "2" } }),
              );
              assert.equal(
                new TextDecoder().decode((await reader.read()).value),
                "event: revoked\ndata: {}\n\n",
              );
              assert.equal((await reader.read()).done, true);
            } finally {
              await reader.cancel();
            }
          } finally {
            await server.dispose();
          }
        });
      }).pipe(Effect.provide(pgliteLayer())),
    ));
}
