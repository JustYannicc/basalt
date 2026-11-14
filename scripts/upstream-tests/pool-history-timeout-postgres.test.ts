import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import { HostedExecutor } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { poolAppUsage } from "../../.upstream/apps/hosted/server/src/implementation/pool-app-ui.ts";
import { apiEquivalentUnavailable, outsideSeries } from "../../apps/pool/usage-series-contract.ts";
import { app, organization, caller, postgresFixture } from "./org-lock-postgres-fixture.ts";
import { runtime, seed, sdk } from "./pool-membership-query-fixture.ts";

const bounds = { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" };
const empty = {
  ...bounds,
  bucket: "day",
  asOf: null,
  groups: [],
  next: null,
  coverage: {
    sources: [],
    firstAt: null,
    lastAt: null,
    capturedThrough: null,
    mapping: {
      current: true,
      historicalGenerations: "unknown",
      proof: "proven",
      mapped: 0,
      unmapped: 0,
      otherAccounts: 0,
    },
    pricing: {
      homeCharge: 0,
      importedApiPrice: 0,
      unpriced: 0,
      missing: 0,
      missingSnapshot: 0,
      missingVersion: 0,
      apiEquivalent: apiEquivalentUnavailable,
    },
    priceProjection: outsideSeries,
    percentiles: outsideSeries,
    seasonalTrainingRange: outsideSeries,
  },
};

test("the app-origin History route preserves a timeout and recovers without weakening access", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 1, hosted: true });
      yield* sql`alter table hosted_account_access add column creator_id text default 'owner',
      add column revision text default 'fixture-revision'`;
      const { executor } = runtime(sql);
      const version = sdk.VersionId.make("dpl_history_timeout");
      const authorize = Effect.succeed({
        app: { id: app, activeVersion: version },
        access: {
          organization,
          owner: sdk.OwnerId.make(`organization:${organization}`),
          role: "admin" as const,
          userId: caller,
        },
      });
      let status = 504,
        calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls++;
        return Response.json(
          status === 504 ? { error: "history_timeout", message: "private backend detail" } : empty,
          { status },
        );
      };
      // This route uses only the transaction and acquisition capabilities in this fixture.
      const hosted = executor as unknown as sdk.Executor;
      const request = () =>
        poolAppUsage(authorize).pipe(
          Effect.provideService(HostedExecutor, Effect.succeed(hosted)),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("https://app.example.invalid/_executor/api/pool-usage/series", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ version, input: { ...bounds, bucket: "day", by: [] } }),
              }),
            ),
          ),
        );
      const timeout = yield* request();
      assert.equal(timeout.status, 504);
      assert.equal(timeout.body._tag, "Uint8Array");
      if (timeout.body._tag === "Uint8Array")
        assert.deepEqual(JSON.parse(new TextDecoder().decode(timeout.body.body)), {
          _tag: "UiFailed",
          reason: "timeout",
        });
      status = 200;
      assert.equal((yield* request()).status, 200);
      yield* sql`delete from hosted_app_access where id=${app}`;
      assert.equal((yield* request()).status, 403);
      assert.equal(calls, 2);
    }),
  );
});
