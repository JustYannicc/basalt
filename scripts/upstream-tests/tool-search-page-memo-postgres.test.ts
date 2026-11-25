import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Crypto, Effect } from "effect";
import type { ToolSearchScope } from "../../.upstream/packages/sdk/src/contracts/tools.ts";
import type { ToolSearchStore } from "../../.upstream/packages/sdk/src/implementation/tool-search-store.ts";
import { searchPostgres, target, tool } from "./tool-search-postgres-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const [search, memos, shared] = await Promise.all([
  load("packages/sdk/src/implementation/tool-search.ts") as Promise<
    typeof import("../../.upstream/packages/sdk/src/implementation/tool-search.ts")
  >,
  load("packages/sdk/src/implementation/tool-search-memo.ts") as Promise<
    typeof import("../../.upstream/packages/sdk/src/implementation/tool-search-memo.ts")
  >,
  load("packages/sdk/src/contracts/shared.ts") as Promise<
    typeof import("../../.upstream/packages/sdk/src/contracts/shared.ts")
  >,
]);

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
// The account-set digest `makeToolSearch` gives a target that names no accounts.
const noAccounts = { app: {}, user: {} };
const accountSet = createHash("sha256").update("[]").digest("hex");
const all: ToolSearchScope = { all: true, readOnly: false, names: [] };

/** The SDK's ranking over the real store, counting the statements that rank. */
const ranking = (
  store: ToolSearchStore,
  around: {
    readonly before?: () => Effect.Effect<void>;
    readonly after?: () => Effect.Effect<void>;
  } = {},
) => {
  let pages = 0;
  // Every ranking runs this statement, with or without the memo.
  const versionedPage: ToolSearchStore["versionedPage"] = (input) =>
    (around.before?.() ?? Effect.void).pipe(
      Effect.andThen(store.versionedPage(input)),
      Effect.tap(() =>
        Effect.sync(() => {
          pages++;
        }),
      ),
      Effect.tap(() => around.after?.() ?? Effect.void),
    );
  const counted: ToolSearchStore = {
    ...store,
    versionedPage,
    page: (input) => Effect.map(versionedPage(input), ({ page }) => page),
  };
  const page = search.makeToolSearch({ store: counted, crypto }).page;
  return { page, pages: () => pages };
};

const searched = (listing: string, scopes: ToolSearchScope[] = [all], query = "needle") => ({
  targets: [
    {
      listing: target(listing).listing,
      app: shared.AppId.make("app_search"),
      accounts: noAccounts,
      labels: ["Search"],
      scopes,
    },
  ],
  query,
  offset: 0,
  limit: 10,
});

test("a repeated search in one session ranks its rows once and returns the same page", async () => {
  await searchPostgres(({ store, listing }) =>
    Effect.gen(function* () {
      yield* listing(target("memo", { target: accountSet }), [
        tool("needle.read", ["needle"]),
        tool("other", ["other"]),
      ]);
      const memo = memos.makeToolSearchPageMemo();
      const { page, pages } = ranking(store);
      const first = yield* page(searched("memo")).pipe(
        Effect.provideService(memos.ToolSearchPageCache, memo),
      );
      const second = yield* page(searched("memo")).pipe(
        Effect.provideService(memos.ToolSearchPageCache, memo),
      );
      assert.equal(pages(), 1);
      assert.deepEqual(second, first);
      assert.deepEqual(
        first.items.map(({ tool }) => tool.name),
        ["needle.read"],
      );
      // Outside a session nothing is kept: every search ranks.
      yield* page(searched("memo"));
      yield* page(searched("memo"));
      assert.equal(pages(), 3);
    }),
  );
});

test("a removed permission or another caller's access never reuses a page", async () => {
  await searchPostgres(({ store, listing }) =>
    Effect.gen(function* () {
      yield* listing(target("access", { target: accountSet }), [
        tool("needle.read", ["needle"]),
        tool("needle.secret", ["needle", "needle"]),
      ]);
      const memo = memos.makeToolSearchPageMemo();
      const { page, pages } = ranking(store);
      const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(memos.ToolSearchPageCache, memo));
      const granted = yield* inSession(page(searched("access")));
      assert.deepEqual(
        granted.items.map(({ tool }) => tool.name),
        ["needle.secret", "needle.read"],
      );
      // The policy read for the next request hides the secret tool: its scope is part of the key.
      const narrowed = [all, { readOnly: false, names: [shared.ToolName.make("needle.read")] }];
      const restricted = yield* inSession(page(searched("access", narrowed)));
      assert.equal(pages(), 2);
      assert.deepEqual(
        restricted.items.map(({ tool }) => tool.name),
        ["needle.read"],
      );
      // The wider page is still kept, and is served only to an input that carries its scopes.
      const again = yield* inSession(page(searched("access", narrowed)));
      assert.equal(pages(), 2);
      assert.deepEqual(again, restricted);
      const none = yield* inSession(page(searched("access", [{ readOnly: false, names: [] }])));
      assert.equal(pages(), 3);
      assert.deepEqual(none.items, []);
    }),
  );
});

test("a rewritten or removed listing is ranked again", async () => {
  await searchPostgres(({ sql, store }) =>
    Effect.gen(function* () {
      const memo = memos.makeToolSearchPageMemo();
      const { page, pages } = ranking(store);
      const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(memos.ToolSearchPageCache, memo));
      const write = (at: number, digest: string, tools: ReturnType<typeof tool>[]) =>
        store.write(
          {
            listing: target("deployed").listing,
            app: shared.AppId.make("app_search"),
            target: accountSet,
            owner: shared.OwnerId.make("organization:org_search"),
            version: shared.VersionId.make("dpl_search"),
            at,
            digest,
            routers: [],
          },
          { tools, definitions: [] },
        );
      yield* write(1, "first", [tool("needle.old", ["needle"])]);
      const before = yield* inSession(page(searched("deployed")));
      assert.deepEqual(
        before.items.map(({ tool }) => tool.name),
        ["needle.old"],
      );
      // The same listing evaluated again with other tools: its digest, and so the key, changes.
      yield* write(2, "second", [tool("needle.new", ["needle"])]);
      const after = yield* inSession(page(searched("deployed")));
      assert.equal(pages(), 2);
      assert.deepEqual(
        after.items.map(({ tool }) => tool.name),
        ["needle.new"],
      );
      yield* sql`delete from executor_tool_search_listings where listing = 'deployed'`;
      const removed = yield* inSession(page(searched("deployed")));
      assert.equal(pages(), 3);
      assert.deepEqual(removed.missing, [0]);
      assert.deepEqual(removed.items, []);
    }),
  );
});

test("a page ranked while its listing was rewritten never stands for the version read first", async () => {
  await searchPostgres(({ sql, store }) =>
    Effect.gen(function* () {
      const write = (digest: string, at: number, tools: ReturnType<typeof tool>[]) =>
        store.write(
          {
            listing: target("racing").listing,
            app: shared.AppId.make("app_search"),
            target: accountSet,
            owner: shared.OwnerId.make("organization:org_search"),
            version: shared.VersionId.make("dpl_search"),
            at,
            digest,
            routers: [],
          },
          { tools, definitions: [] },
        );
      // Cleanup removes a listing with its rows, as `removeToolSearch` does.
      const remove = Effect.gen(function* () {
        yield* sql`delete from executor_tool_search where listing = 'racing'`;
        yield* sql`delete from executor_tool_search_definitions where listing = 'racing'`;
        yield* sql`delete from executor_tool_search_listings where listing = 'racing'`;
      }).pipe(Effect.orDie);
      yield* write("one", 1, [tool("needle.a", ["needle"])]);
      const memo = memos.makeToolSearchPageMemo();
      // After the search read the version, other rows are committed before it ranks. Before the
      // next search, the listing is removed and the first version is written again with its rows,
      // so the next search reads exactly the version the first one read.
      let raced = false;
      const { page, pages } = ranking(store, {
        before: () =>
          raced ? Effect.void : write("two", 2, [tool("needle.b", ["needle"])]).pipe(Effect.orDie),
        after: () =>
          raced
            ? Effect.void
            : Effect.suspend(() => {
                raced = true;
                return remove.pipe(
                  Effect.andThen(write("one", 1, [tool("needle.a", ["needle"])])),
                  Effect.orDie,
                );
              }),
      });
      const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(memos.ToolSearchPageCache, memo));
      const ranked = yield* inSession(page(searched("racing")));
      assert.deepEqual(
        ranked.items.map(({ tool }) => tool.name),
        ["needle.b"],
      );
      // The page was ranked from the second rows, so it was never kept under the first version.
      const back = yield* inSession(page(searched("racing")));
      assert.equal(pages(), 2);
      assert.deepEqual(
        back.items.map(({ tool }) => tool.name),
        ["needle.a"],
      );
    }),
  );
});

test("rows rewritten under an earlier digest are ranked again", async () => {
  await searchPostgres(({ store }) =>
    Effect.gen(function* () {
      let at = 1;
      const annotated = (destructive: boolean) => {
        const base = tool("needle.write", ["needle"]);
        return { ...base, tool: { ...base.tool, annotations: { destructiveHint: destructive } } };
      };
      const write = (digest: string, tools: ReturnType<typeof tool>[]) =>
        store.write(
          {
            listing: target("annotated").listing,
            app: shared.AppId.make("app_search"),
            target: accountSet,
            owner: shared.OwnerId.make("organization:org_search"),
            version: shared.VersionId.make("dpl_search"),
            at: at++,
            digest,
            routers: [],
          },
          { tools, definitions: [] },
        );
      const memo = memos.makeToolSearchPageMemo();
      const { page, pages } = ranking(store);
      const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(memos.ToolSearchPageCache, memo));
      const destructive = (found: Effect.Success<ReturnType<typeof page>>) =>
        found.items.map(({ tool }) => tool.annotations?.destructiveHint);
      yield* write("one", [annotated(false)]);
      assert.deepEqual(destructive(yield* inSession(page(searched("annotated")))), [false]);
      // The digest does not cover annotations; a write in between forces the rows to be rewritten,
      // so the first digest returns with other rows and a newer time.
      yield* write("two", [tool("needle.other", ["needle"])]);
      yield* write("one", [annotated(true)]);
      assert.deepEqual(destructive(yield* inSession(page(searched("annotated")))), [true]);
      assert.equal(pages(), 2);
    }),
  );
});

test("the memo keeps at most its bounds and hands out copies", () => {
  const limits = { entries: 2, entryBytes: 100, totalBytes: 150, ttlMillis: 1_000 };
  const memo = memos.makeToolSearchPageMemo(limits);
  const page = (name: string) => ({
    total: 1,
    missing: [],
    items: [{ target: 0, ordinals: [0], listing: name, tool: tool(name, []).tool, router: null }],
    definitions: [],
  });
  memo.set("a", page("a"), 60, 0);
  memo.set("b", page("b"), 60, 0);
  // Reading `a` makes `b` the least recently used; a third entry evicts it.
  assert.ok(memo.get("a", 1));
  memo.set("c", page("c"), 60, 2);
  assert.equal(memo.get("b", 3), undefined);
  assert.ok(memo.get("a", 3));
  assert.ok(memo.get("c", 3));
  // Over the byte bound the least recently used goes first; an oversized page is never kept.
  memo.set("d", page("d"), 90, 4);
  assert.equal(memo.get("a", 5), undefined);
  memo.set("huge", page("huge"), 101, 5);
  assert.equal(memo.get("huge", 6), undefined);
  // A returned page is a copy: changing it changes nothing kept.
  const copy = memo.get("d", 6)!;
  Reflect.set(copy, "total", 0);
  assert.equal(memo.get("d", 7)!.total, 1);
  // Entries expire after the TTL.
  assert.equal(memo.get("d", 4 + limits.ttlMillis), undefined);
});
