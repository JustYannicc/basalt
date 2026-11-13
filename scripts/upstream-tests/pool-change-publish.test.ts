import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { ScopedChanges } from "../../.upstream/apps/hosted/server/src/implementation/scoped-changes.ts";
import {
  poolChangePath,
  publishCommittedChanges,
} from "../../.upstream/apps/hosted/server/src/implementation/pool-change-publish.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { RuntimeProtocolFailed } from "../../.upstream/packages/sdk/src/contracts/runtime.ts";

test("signed producer revisions commit once, survive delivery failure and never replace newer heads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`create table executor_apps (id text primary key,owner text,active_deployment text)`;
      yield* migrateChangeRevisions;
      const delivered: string[] = [];
      let unavailable = true;
      const transport = ScopedChanges.of({
        subscribe: () => {
          throw new Error("unused subscription");
        },
        publish: (_scope, hint) =>
          unavailable
            ? Effect.fail(new RuntimeProtocolFailed())
            : Effect.sync(() => {
                delivered.push(hint.revision);
              }),
      });
      const route = HttpRouter.add("POST", poolChangePath, publishCommittedChanges).pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(
            Layer.succeed(GroupDatabase, Effect.succeed(sql)),
            Layer.succeed(ScopedChanges, transport),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ POOL_APP_SIGNING_KEY: "19".repeat(32) }),
            ),
          ),
        ),
        Layer.provide(HttpServer.layerServices),
      );
      yield* Effect.tryPromise(async () => {
        const server = HttpRouter.toWebHandler(route, { disableLogger: true });
        const key = { topic: "pool-samples", resource: "app_fixture" };
        const send = async (
          revision: string,
          options: { scope?: string; at?: number; expiresAt?: number } = {},
        ) => {
          const at = options.at ?? Date.now();
          const envelope = await signEnvelope("19".repeat(32), "sbcr1", {
            action: "publish-changes",
            at,
            expiresAt: options.expiresAt ?? at + 30_000,
            changes: [{ scope: options.scope ?? "pool:app_fixture", hint: { ...key, revision } }],
          });
          return server.handler(
            new Request(`https://changes.example.test${poolChangePath}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ envelope }),
            }),
          );
        };
        try {
          assert.equal((await send("1")).status, 503);
          const journal = makeChangeJournal(sql);
          assert.equal(
            (await Effect.runPromise(journal.current("pool:app_fixture", [key])))[0]!.revision,
            "1",
          );
          assert.deepEqual(delivered, []);
          unavailable = false;
          assert.equal((await send("1")).status, 204);
          assert.deepEqual(delivered, ["1"]);
          assert.equal((await send("1")).status, 204);
          assert.equal((await send("3")).status, 204);
          assert.equal((await send("2")).status, 204);
          assert.deepEqual(delivered, ["1", "3"]);
          assert.equal((await send("4", { scope: "pool:app_other" })).status, 400);
          assert.equal((await send("4", { scope: "pool-history:app_fixture" })).status, 400);
          assert.equal(
            (await send("4", { at: Date.now() - 40_000, expiresAt: Date.now() - 10_000 })).status,
            401,
          );
          assert.equal(
            (await Effect.runPromise(journal.current("pool:app_fixture", [key])))[0]!.revision,
            "3",
          );
        } finally {
          await server.dispose();
        }
      });
    }).pipe(Effect.provide(pgliteLayer())),
  ));
