import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { FetchHttpClient } from "effect/http";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { AppId, OwnerId } from "../../.upstream/packages/sdk/src/core.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationId,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { PoolUsageBackend } from "../../.upstream/apps/hosted/server/src/contracts/pool-usage.ts";
import { poolUsage } from "../../.upstream/apps/hosted/server/src/implementation/pool-usage.ts";
import { poolModels } from "../../.upstream/apps/hosted/server/src/implementation/pool-models.ts";
import { AppModels } from "../../src/pool/app-models.ts";
import { fixture, owner, pool, signingKey } from "../../src/pool/test/computers.ts";

const app = AppId.make("app_assertion_window");
const selected = AppId.make("app_assertion_pool");
const organization = OrganizationId.make(pool.organization);
const completion = {
  id: "completion-fixture",
  object: "chat.completion",
  created: 1,
  model: "synthetic-model",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

for (const operation of ["usage", "model"] as const) {
  test(`hosted ${operation} reaches the real pool with a signer clock 50ms ahead`, async (t) => {
    const f = fixture({
      summary: async () => ({
        scope: "pool",
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        total: {
          requests: 0,
          cost: 0,
          unpriced: 0,
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
        },
        models: [],
        days: [],
        members: [],
        accounts: [],
        cap: null,
        readAt: null,
      }),
      setCap: async () => {},
    });
    const selectedPool = {
      ...pool,
      pool: selected,
      users: [owner],
      managers: [owner],
      authorization: "executor-app-v1" as const,
    };
    assert.equal((await f.access({ action: "audience", pools: [selectedPool] })).status, 200);
    const model = new AppModels({
      storage: f.storage,
      home: f.home,
      signingKey,
      now: f.now,
      schedule: async () => {},
      ready: async () => true,
      forward: async () => Response.json(completion),
    });
    t.mock.method(Date, "now", () => f.now() + 50);
    const observed: { path: string; status: number }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const response =
        path === "/__models/v1/request" ? await model.handle(request) : await f.setup(request);
      observed.push({ path, status: response.status });
      return response;
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const statement of [
            'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
            'create table "user" (id text, name text, email text)',
            "create table organization (id text, metadata text)",
            "create table executor_apps (id text, owner text)",
            "create table hosted_app_access (id text, organization_id text, creator_id text, audience text, revision text)",
            "create table hosted_app_groups (app_id text, group_id text)",
            "create table hosted_group_members (group_id text, member_id text)",
            "create table hosted_model_bindings (id text, app_id text, requirement text, subject text, pool_id text, authorizer text, model text, limits jsonb, revision int)",
          ])
            yield* sql.unsafe(statement);
          yield* sql`insert into member values ('member-fixture', ${organization}, ${owner}, 'owner')`;
          yield* sql`insert into organization values (${organization}, ${JSON.stringify({ basaltPools: { [owner]: { app: selected, owner, authorization: "executor-app-v1" } } })})`;
          yield* sql`insert into executor_apps values (${selected}, ${"organization:" + organization})`;
          yield* sql`insert into hosted_app_access values (${selected}, ${organization}, null, 'private', 'revision-one'), (${app}, ${organization}, ${owner}, 'private', 'revision-one')`;
          const context = {
            organization,
            role: "owner" as const,
            owner: OwnerId.make("organization:" + organization),
          };
          if (operation === "usage") {
            const usage = yield* poolUsage(selected).pipe(
              Effect.provideService(GroupDatabase, Effect.succeed(sql)),
              Effect.provideService(CurrentUserId, owner),
              Effect.provideService(CurrentOrganization, context),
              Effect.provideService(PoolUsageBackend, {
                origin: "https://pool.example",
                key: Redacted.make(signingKey),
              }),
            );
            assert.equal(usage?.pool, selected);
            assert.deepEqual(usage?.members, []);
            return;
          }
          // The app receives pool use only after its own policy and current membership checks succeed.
          yield* sql`update hosted_app_access set creator_id = ${owner} where id = ${selected}`;
          yield* sql`insert into hosted_model_bindings values ('binding-fixture', ${app}, 'chat', '', ${selected}, ${owner}, 'synthetic-model', '{}', 1)`;
          const result = yield* poolModels(
            Option.some(Redacted.make(signingKey)),
            "https://pool.example",
            Effect.succeed(sql),
          ).request({
            app,
            build: "build-assertion-fixture",
            requirement: "chat",
            declaration: { scope: "app", model: "synthetic-model" },
            caller: owner,
            request: { messages: [{ role: "user", content: "Hello" }] },
          });
          assert.deepEqual(result, completion);
        }).pipe(Effect.provide(pgliteLayer()), Effect.provideService(FetchHttpClient.Fetch, fetch)),
      ),
    );
    assert.deepEqual(observed, [
      {
        path: operation === "usage" ? "/pool/v1/managed-usage" : "/__models/v1/request",
        status: 200,
      },
    ]);
  });
}

test("hosted access acknowledgements reach the real receiver with 50ms of skew", async (t) => {
  const { acknowledgePoolChange } =
    await import("../../.upstream/apps/hosted/server/src/implementation/pool-receiver.ts");
  const { readAccess } = await import("../../src/pool/access.ts");
  const receiverNow = Date.parse("2026-01-01T00:00:00Z");
  t.mock.method(Date, "now", () => receiverNow + 50);
  const accepted: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const value = await readAccess(new Request(input, init), signingKey, undefined, receiverNow);
    accepted.push(value.action);
    return Response.json({ revoked: 0 });
  };
  await Effect.runPromise(
    acknowledgePoolChange(
      Redacted.make(signingKey),
      "https://pool.example",
      "/pool/v1/access",
      "sba1",
      {
        action: "pool-deleted",
        pool: selected,
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  );
  assert.deepEqual(accepted, ["pool-deleted"]);
});
