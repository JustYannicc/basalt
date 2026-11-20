import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, type Schema } from "effect";
import { SqlClient } from "effect/sql";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import { type App, OwnerId } from "@executor-js/sdk/core";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationId,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { PoolUsageBackend } from "../../.upstream/apps/hosted/server/src/contracts/pool-usage.ts";
import { withPoolViewCache } from "../../.upstream/apps/hosted/server/src/implementation/pool-view-cache.ts";
import { readCommittedPoolChanges } from "../../src/pool/change-http.ts";
import { fixture } from "./account-change-fixture.ts";

const signingKey = "ab".repeat(32);
const organization = OrganizationId.make("team-a");
// Only what the cache and its guard read; the view's own code is each test's `read`.
const app = {
  id: "app_a",
  owner: "organization:team-a",
  activeVersion: "version-fixture",
  requirements: { accounts: { pool: {} }, dependencies: { accountView: {} } },
} as unknown as App;

const registerPool = (sql: SqlClient.SqlClient) =>
  sql`update organization set metadata = ${JSON.stringify({ basaltPools: { "viewer-a": { app: "app_a" } } })} where id = 'team-a'`;

/** One signed-in `view` request through the host's cache, its real guard and the saved registration. */
const view = (
  sql: SqlClient.SqlClient,
  session: string,
  pool: (request: Request) => Promise<Response>,
  read: Effect.Effect<Schema.Json>,
) =>
  withPoolViewCache(app, { name: "view", input: {} }, read).pipe(
    Effect.provideService(GroupDatabase, Effect.succeed(sql)),
    Effect.provideService(CurrentUserId, "viewer-a"),
    Effect.provideService(CurrentOrganization, {
      organization,
      role: "member" as const,
      owner: OwnerId.make(`organization:${organization}`),
    }),
    Effect.provideService(PoolUsageBackend, {
      origin: "https://pool.example",
      key: Redacted.make(signingKey),
    }),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => pool(new Request(input, init))),
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("https://tools.example/api/apps/app_a/query", {
          method: "POST",
          headers: { cookie: `session=${session}` },
        }),
      ),
    ),
    // A refusal becomes a value, so the assertion shows which answer the view got.
    Effect.result,
    Effect.map((result) => (result._tag === "Success" ? result.success : result.failure)),
  );

test("a pool that does not answer its revisions call gets the view's own answer, not a storage error", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* registerPool(sql);
      const unavailable = {
        ok: false,
        error: "backend_unavailable",
        message: "The pool didn't answer. Try again in a moment.",
      };
      let asked = 0;
      let reads = 0;
      // What a layer in front of the pool Worker answers when the pool itself is not reached.
      const silent = async () => {
        asked++;
        return new Response(null, { status: 404 });
      };
      const read = Effect.sync((): Schema.Json => {
        reads++;
        return unavailable;
      });
      assert.deepEqual(yield* view(sql, "outage", silent, read), unavailable);
      assert.equal(asked, 1, "the guard asked the pool for its revisions and got no answer");
      assert.equal(reads, 1);
      assert.deepEqual(yield* view(sql, "outage", silent, read), unavailable);
      assert.equal(reads, 2, "each request during the outage reads again");
    }),
  ));

test("a view read while the revisions call failed is never stored", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* registerPool(sql);
      const heads = { revisions: [{ topic: "pool-readings", resource: "app_a", revision: "1" }] };
      let reachable = false;
      let reads = 0;
      const pool = async (request: Request) =>
        reachable
          ? readCommittedPoolChanges(request, { signingKey, current: async () => heads })
          : new Response(null, { status: 404 });
      // The pool's own read still answers here, with a result the cache would otherwise keep.
      const read = Effect.sync((): Schema.Json => ({ ok: true, value: { read: ++reads } }));
      assert.deepEqual(yield* view(sql, "recovery", pool, read), { ok: true, value: { read: 1 } });
      reachable = true;
      assert.deepEqual(
        yield* view(sql, "recovery", pool, read),
        { ok: true, value: { read: 2 } },
        "the read made while the guard failed was not stored",
      );
      assert.deepEqual(
        yield* view(sql, "recovery", pool, read),
        { ok: true, value: { read: 2 } },
        "a read under answered, equal heads is reused",
      );
      assert.equal(reads, 2);
    }),
  ));
