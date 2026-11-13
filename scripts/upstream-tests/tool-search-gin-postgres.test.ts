import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { CurrentTransformer } from "effect/sql/Statement";
import { AppId } from "../../.upstream/packages/sdk/src/core.ts";
import { searchPostgres, target, tool } from "./tool-search-postgres-fixture.ts";

test("indexed search intersects scopes and keeps every permitted duplicate target", async () => {
  await searchPostgres(({ store, listing }) =>
    Effect.gen(function* () {
      const first = target("first");
      const second = target("second");
      yield* listing(first, [
        tool("same", ["other"], { tool: { ...tool("same", []).tool, router: "" } }),
        tool("secret", ["needle", "needle"]),
      ]);
      yield* listing(second, [tool("same", ["needle"], { definitions: [0] })]);
      const permitted = [
        target("first", { scopes: [{ readOnly: false, names: [tool("same", []).name] }] }),
        second,
      ];
      const page = yield* store.page({
        targets: permitted,
        terms: ["needle"],
        offset: 0,
        limit: 10,
      });
      assert.equal(page.total, 1);
      assert.deepEqual(
        page.items.map(({ target, ordinals, listing, tool }) => ({
          target,
          ordinals,
          listing,
          name: tool.name,
        })),
        [{ target: 0, ordinals: [0, 1], listing: "first", name: "same" }],
      );
      assert.deepEqual(page.definitions, []);
      assert.deepEqual(page.items[0]?.router, { path: "", title: "Synthetic search" });
      const onlyLater = yield* store.page({
        targets: [second],
        terms: ["needle"],
        offset: 0,
        limit: 10,
      });
      assert.deepEqual(onlyLater.definitions, [["second", 0, { type: "string" }]]);
      const wrongDigest = yield* store.page({
        targets: [target("second", { target: "wrong" })],
        terms: ["needle"],
        offset: 0,
        limit: 10,
      });
      assert.deepEqual(wrongDigest, { total: 0, missing: [0], items: [], definitions: [] });
      const wrongApp = yield* store.page({
        targets: [target("second", { app: AppId.make("app_unrelated") })],
        terms: ["needle"],
        offset: 0,
        limit: 10,
      });
      assert.deepEqual(wrongApp, { total: 0, missing: [0], items: [], definitions: [] });
    }),
  );
});

test("label-only and combined hits preserve frequency, corpus statistics and pagination", async () => {
  await searchPostgres(({ store, listing }) =>
    Effect.gen(function* () {
      const labelled = target("labelled", { labels: ["needle", "needle"] });
      yield* listing(labelled, [tool("b", ["ordinary"]), tool("a", ["needle"])]);
      yield* listing(target("plain"), [tool("c", ["needle", "needle"]), tool("d", ["ordinary"])]);
      const targets = [labelled, target("plain")];
      const page = yield* store.page({ targets, terms: ["needle"], offset: 0, limit: 10 });
      assert.equal(page.total, 3);
      assert.deepEqual(
        page.items.map(({ tool }) => tool.name),
        ["a", "c", "b"],
      );
      const repeated = yield* store.page({
        targets,
        terms: ["needle", "needle"],
        offset: 0,
        limit: 10,
      });
      assert.deepEqual(repeated, page);
      const next = yield* store.page({ targets, terms: ["needle"], offset: 1, limit: 1 });
      assert.equal(next.total, 3);
      assert.deepEqual(next.items, page.items.slice(1, 2));
      const labels = yield* store.page({
        targets: [target("plain", { labels: ["label"] })],
        terms: ["label"],
        offset: 0,
        limit: 10,
      });
      assert.deepEqual(
        labels.items.map(({ tool }) => tool.name),
        ["d", "c"],
      );
    }),
  );
});

test("search preserves nested read-only, exclusion and below filters for words and labels", async () => {
  await searchPostgres(({ store, listing }) =>
    Effect.gen(function* () {
      yield* listing(target("permissions"), [
        tool("tree.read", ["needle"]),
        tool("tree.write", ["needle"], { readOnly: false }),
        tool("tree.secret", ["needle", "needle"]),
        tool("other.read", ["needle"]),
      ]);
      const restricted = target("permissions", {
        labels: ["label"],
        below: "tree",
        scopes: [
          { readOnly: true, names: [] },
          { all: true, readOnly: false, names: [], excludedNames: [tool("tree.secret", []).name] },
        ],
      });
      for (const terms of [["needle"], ["label"], []]) {
        const page = yield* store.page({ targets: [restricted], terms, offset: 0, limit: 10 });
        assert.equal(page.total, 1);
        assert.equal(page.items[0]?.tool.name, "tree.read");
      }
      const empty = yield* store.page({
        targets: [target("permissions", { scopes: [{ readOnly: false, names: [] }] })],
        terms: ["needle"],
        offset: 0,
        limit: 10,
      });
      assert.deepEqual(empty, { total: 0, missing: [], items: [], definitions: [] });
    }),
  );
});

test("ranking statistics include permitted tools whose own words do not match", async () => {
  await searchPostgres(({ store, listing }) =>
    Effect.gen(function* () {
      const selected = target("statistics");
      yield* listing(selected, [
        tool("short", ["needle", "ordinary"]),
        tool("long", [
          ...Array.from({ length: 3 }, () => "needle"),
          ...Array.from({ length: 20 }, () => "ordinary"),
        ]),
        ...Array.from({ length: 20 }, (_, i) =>
          tool(
            `filler${i}`,
            Array.from({ length: 200 }, () => "ordinary"),
          ),
        ),
      ]);
      const page = yield* store.page({
        targets: [selected],
        terms: ["needle"],
        offset: 0,
        limit: 10,
      });
      assert.deepEqual(
        page.items.map(({ tool }) => tool.name),
        ["long", "short"],
      );
      const noTerms = yield* store.page({
        targets: [selected, target("absent")],
        terms: [],
        offset: 20,
        limit: 2,
      });
      assert.equal(noTerms.total, 22);
      assert.deepEqual(noTerms.missing, [1]);
      assert.deepEqual(
        noTerms.items.map(({ tool }) => tool.name),
        ["long", "short"],
      );
      assert.deepEqual(
        yield* store.page({ targets: [], terms: ["needle"], offset: 0, limit: 10 }),
        { total: 0, missing: [], items: [], definitions: [] },
      );
    }),
  );
});

interface Plan {
  readonly "Index Name"?: string;
  readonly Plans?: readonly Plan[];
}
const indexes = (plan: Plan): readonly string[] => [
  ...(plan["Index Name"] ? [plan["Index Name"]] : []),
  ...(plan.Plans ?? []).flatMap(indexes),
];

test("selective search reaches the existing GIN index over an 8800-tool corpus", async () => {
  await searchPostgres(({ sql, store, listing }) =>
    Effect.gen(function* () {
      const selected = target("large");
      yield* listing(
        selected,
        Array.from({ length: 8800 }, (_, i) =>
          tool(`tool${String(i).padStart(4, "0")}`, [i === 777 ? "needle" : "ordinary", "catalog"]),
        ),
      );
      yield* sql`analyze executor_tool_search`;
      const statements: Array<readonly [string, readonly unknown[]]> = [];
      const page = yield* store
        .page({ targets: [selected], terms: ["needle"], offset: 0, limit: 10 })
        .pipe(
          Effect.provideService(CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
      assert.equal(page.total, 1);
      assert.equal(page.items[0]?.tool.name, "tool0777");
      assert.equal(statements.length, 1, "ranking and hydration share one PostgreSQL snapshot");
      const query = statements[0]!;
      const [row] = yield* sql.unsafe<{ "QUERY PLAN": readonly { Plan: Plan }[] }>(
        `explain (analyze, buffers, format json) ${query[0]}`,
        query[1],
      );
      assert.ok(row);
      assert.ok(
        indexes(row["QUERY PLAN"][0]!.Plan).includes("executor_tool_search_terms"),
        "selective terms use the stored expression index before materializing candidates",
      );
    }),
  );
});
