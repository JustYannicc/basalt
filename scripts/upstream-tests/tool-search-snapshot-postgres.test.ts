import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { CurrentTransformer } from "effect/sql/Statement";
import { OwnerId, VersionId } from "../../.upstream/packages/sdk/src/core.ts";
import { until } from "./org-lock-postgres-fixture.ts";
import { searchPostgres, target, tool } from "./tool-search-postgres-fixture.ts";

test("search ranking and hydration retain one snapshot while a listing is replaced", async () => {
  await searchPostgres(({ sql, store, listing }) =>
    Effect.gen(function* () {
      const selected = target("replacement");
      yield* listing(selected, [
        tool("old", ["needle"], {
          tool: { ...tool("old", []).tool, router: "group" },
          definitions: [0],
        }),
      ]);
      const input = { targets: [selected], terms: ["needle"], offset: 0, limit: 10 };
      const before = yield* store.page(input);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* Effect.forkChild(
        sql.withTransaction(
          sql`select pg_advisory_xact_lock(591)`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      yield* Deferred.await(held);
      let statements = 0;
      yield* Effect.gen(function* () {
        const read = yield* Effect.forkChild(
          store.page(input).pipe(
            Effect.provideService(CurrentTransformer, (statement) =>
              Effect.sync(() => {
                statements++;
                const [query, parameters] = statement.compile();
                // The extra FROM holds this statement after its snapshot starts, without splitting it.
                return sql.unsafe(
                  `${query} from (select pg_advisory_xact_lock(591)) fixture_gate`,
                  parameters,
                );
              }),
            ),
          ),
        );
        yield* until(
          sql<{ count: number }>`select count(*)::int as count from pg_stat_activity
            where application_name=current_setting('application_name')
              and wait_event_type='Lock' and wait_event='advisory'`,
          (rows) => rows[0]?.count === 1,
        );
        yield* store.write(
          {
            listing: selected.listing,
            app: selected.app,
            target: selected.target,
            owner: OwnerId.make("organization:org_search"),
            version: VersionId.make("dpl_search"),
            at: 2,
            digest: "replacement-two",
            routers: [{ path: "group", title: "Replacement search" }],
          },
          {
            tools: [
              tool("new", ["needle"], {
                tool: { ...tool("new", []).tool, router: "group" },
                definitions: [0],
              }),
            ],
            definitions: [{ type: "number" }],
          },
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(blocker);
        assert.deepEqual(yield* Fiber.join(read), before);
        assert.equal(statements, 1);
        const after = yield* store.page(input);
        assert.equal(after.items[0]?.tool.name, "new");
        assert.deepEqual(after.items[0]?.router, { path: "group", title: "Replacement search" });
        assert.deepEqual(after.definitions, [["replacement", 0, { type: "number" }]]);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );
});
