import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);

test("the connections inventory lists one organization's connections as metadata only", async () => {
  const [sdk, ops] = await Promise.all([
    load("packages/sdk/src/core.ts"),
    load("apps/hosted/cloud/src/infrastructure/production-ops/inventory.ts"),
  ]);
  assert.ok(
    Object.hasOwn(ops.inventoryQueries, "connections"),
    "The inventory has a connections selection",
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const storage = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const row = (
          id: string,
          organization: string,
          state: object,
          app: string,
          created: string,
        ) =>
          sql`insert into executor_account_connections
            (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at, target)
            values (${id}, ${`organization:${organization}`}, 'prv_inventory', null,
              ${JSON.stringify(state)}, 'r1', 'attempt-secret-reference', ${new Date(created)},
              ${new Date(Date.parse(created) + 30 * 60_000)},
              ${JSON.stringify({ app, requirement: "service", name: "Inventory app", owner: `organization:${organization}`, scope: "user" })})`;
        yield* row(
          "conn_a_pending",
          "org_inventory",
          { status: "pending" },
          "app_own",
          "2026-11-01T10:00:00Z",
        );
        yield* row(
          "conn_b_completed",
          "org_inventory",
          { status: "completed", account: { id: "acc_made", label: "Secret label" } },
          "app_own",
          "2026-11-01T11:00:00Z",
        );
        yield* row(
          "conn_c_foreign",
          "org_foreign",
          { status: "pending" },
          "app_foreign",
          "2026-11-01T12:00:00Z",
        );
        // The shipped read: selection lookup, JSON decode and row bound.
        const { rows } = yield* ops.inventory("connections", "org_inventory");
        assert.deepEqual(
          rows.map(({ created_at, expires_at, ...rest }: Record<string, unknown>) => ({
            ...rest,
            created: String(created_at).slice(0, 19),
            expires: String(expires_at).slice(0, 19),
          })),
          [
            {
              id: "conn_a_pending",
              provider: "prv_inventory",
              app: "app_own",
              requirement: "service",
              status: "pending",
              expired: true,
              produced_account: false,
              created: "2026-11-01 10:00:00",
              expires: "2026-11-01 10:30:00",
            },
            {
              id: "conn_b_completed",
              provider: "prv_inventory",
              app: "app_own",
              requirement: "service",
              status: "completed",
              expired: true,
              produced_account: true,
              created: "2026-11-01 11:00:00",
              expires: "2026-11-01 11:30:00",
            },
          ],
        );
        // The counts give the same numbers without the row bound.
        const summary = yield* ops.inventory("connections-summary", "org_inventory");
        assert.deepEqual(
          summary.rows.map(
            ({ first_created_at, last_created_at, ...rest }: Record<string, unknown>) => ({
              ...rest,
              first: String(first_created_at).slice(0, 19),
              last: String(last_created_at).slice(0, 19),
            }),
          ),
          [
            {
              status: "completed",
              expired: true,
              app: "app_own",
              provider: "prv_inventory",
              connections: 1,
              first: "2026-11-01 11:00:00",
              last: "2026-11-01 11:00:00",
            },
            {
              status: "pending",
              expired: true,
              app: "app_own",
              provider: "prv_inventory",
              connections: 1,
              first: "2026-11-01 10:00:00",
              last: "2026-11-01 10:00:00",
            },
          ],
        );
        assert.ok(
          !JSON.stringify(summary.rows).includes("app_foreign"),
          "Another organization's counts",
        );
        // Metadata only: no attempt, account details, or another organization's rows.
        const text = JSON.stringify(rows);
        for (const forbidden of [
          "attempt-secret-reference",
          "Secret label",
          "acc_made",
          "org_foreign",
          "conn_c_foreign",
        ])
          assert.ok(!text.includes(forbidden), forbidden);
      }).pipe(Effect.provide(pgliteLayer())),
    ) as Effect.Effect<void, unknown>,
  );
});
