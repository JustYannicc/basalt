import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type {
  RankedTarget,
  SearchToolRow,
  ToolSearchStore,
} from "../../.upstream/packages/sdk/src/implementation/tool-search-store.ts";
import { postgresFixture } from "./org-lock-postgres-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const [shared, contracts, search] = await Promise.all([
  load("packages/sdk/src/contracts/shared.ts") as Promise<
    typeof import("../../.upstream/packages/sdk/src/contracts/shared.ts")
  >,
  load("packages/sdk/src/contracts/tools.ts") as Promise<
    typeof import("../../.upstream/packages/sdk/src/contracts/tools.ts")
  >,
  load("packages/sdk/src/implementation/tool-search-store.ts") as Promise<
    typeof import("../../.upstream/packages/sdk/src/implementation/tool-search-store.ts")
  >,
]);

export const target = (listing: string, options: Partial<RankedTarget> = {}): RankedTarget => ({
  listing: contracts.ToolSearchListing.make(listing),
  app: shared.AppId.make("app_search"),
  target: listing,
  labels: [],
  scopes: [{ all: true, readOnly: false, names: [] }],
  ...options,
});

export const tool = (
  name: string,
  terms: readonly string[],
  options: Partial<SearchToolRow> = {},
): SearchToolRow => ({
  name: shared.ToolName.make(name),
  terms,
  readOnly: true,
  signature: name,
  tool: {
    name: shared.ToolName.make(name),
    app: shared.AppId.make("app_search"),
    version: shared.VersionId.make("dpl_search"),
    description: name,
    inputSchema: { type: "object" },
  },
  definitions: [],
  ...options,
});

export const searchPostgres = <A, E>(
  run: (input: {
    sql: SqlClient.SqlClient;
    store: ReturnType<typeof search.makeToolSearchStore>;
    listing: (
      selected: RankedTarget,
      tools: readonly SearchToolRow[],
    ) => ReturnType<ToolSearchStore["write"]>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      for (const statement of [
        "create table executor_tool_search_listings (listing text primary key, owner text, app text, deployment text, target text, at bigint, digest text, routers json, superseded bigint)",
        "create table executor_tool_search (id text primary key, listing text, name text, read_only boolean, terms text, length int, signature text, tool json, definitions json)",
        "create index executor_tool_search_listing on executor_tool_search (listing)",
        "create index executor_tool_search_terms on executor_tool_search using gin ((string_to_array(terms, ' ')))",
        "create table executor_tool_search_definitions (id text primary key, listing text, position int, definition json)",
      ])
        yield* sql.unsafe(statement);
      const store = search.makeToolSearchStore(sql);
      const listing = (selected: RankedTarget, tools: readonly SearchToolRow[]) =>
        store.write(
          {
            listing: selected.listing,
            app: selected.app,
            target: selected.target,
            owner: shared.OwnerId.make("organization:org_search"),
            version: shared.VersionId.make("dpl_search"),
            at: 1,
            digest: selected.listing,
            routers: [{ path: "", title: "Synthetic search" }],
          },
          { tools, definitions: [{ type: "string" }] },
        );
      return yield* run({ sql, store, listing });
    }),
  );
