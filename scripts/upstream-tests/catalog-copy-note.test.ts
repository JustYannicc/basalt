import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const read = (path: string) => readFileSync(resolve(upstream, path), "utf8");

const todaysNote = "This app is an independent copy. Changes to the original do not update it.";
const feed = "https://basalt.example/catalog/index.json";
const installed = (reference: string) => ({
  id: "app_crm",
  activeVersion: "dpl_crm",
  copiedFrom: { name: "crm", reference, commit: null },
});
const catalogCopy = installed("https://basalt.example/catalog/apps/crm.json");
const held = {
  source: "digest",
  active: "dpl_crm",
  reconnect: 2,
  reasons: ["scope"],
  touched: false,
};

/** What the server says about one app while the organization's records hold `held` for it. */
const status = async (app: object, input: { feed: string | undefined; manager: boolean }) => {
  const { catalogAppStatus } = await load(
    "apps/hosted/server/src/implementation/catalog-app-offers.ts",
  );
  let reads = 0;
  // The only query is the sweep's records: one organization row.
  const sql = () => {
    reads += 1;
    return Effect.succeed([{ apps: { app_crm: { offer: held } } }]);
  };
  const result = await Effect.runPromise(
    catalogAppStatus("org_1", app, input).pipe(
      Effect.provideService(SqlClient.SqlClient, sql as never),
    ) as Effect.Effect<unknown>,
  );
  return { result, reads };
};

test("a catalog copy this host's releases update says so, and only managers see its held update", async () => {
  assert.deepEqual(await status(catalogCopy, { feed, manager: true }), {
    result: { catalog: true, update: { reconnect: 2, reasons: ["scope"], touched: false } },
    reads: 1,
  });
  assert.deepEqual(await status(catalogCopy, { feed, manager: false }), {
    result: { catalog: true, update: null },
    reads: 0,
  });
});

test("other copies, and every copy on a host whose releases update nothing, do not", async () => {
  const none = { result: { catalog: false, update: null }, reads: 0 };
  // Copied from elsewhere, or from another deployment's feed: a record left for it never shows.
  for (const reference of [
    "https://github.com/example/crm",
    "https://catalog.example/apps/crm.json",
    "https://basalt.example/catalog/apps/a/b.json",
  ])
    assert.deepEqual(await status(installed(reference), { feed, manager: true }), none);
  // A host that runs no release sweep names no feed.
  assert.deepEqual(await status(catalogCopy, { feed: undefined, manager: true }), none);
});

test("Settings never calls a catalog copy independent, and other copies keep today's text", async () => {
  const { copiedFromNote } = await load("apps/hosted/web/src/contracts/catalog-copy.ts");
  const { independentCopyNote } = await load("packages/ui/src/contracts/app-copy.ts");
  const catalog: string = copiedFromNote({ catalog: true });
  assert.doesNotMatch(catalog, /independent|do not update/i);
  assert.match(catalog, /takes the catalog's updates at each release/);
  assert.match(catalog, /wait in Versions/);
  assert.equal(copiedFromNote({ catalog: false }), todaysNote);
  // Hosts that say nothing, like the local app, keep it too.
  assert.equal(independentCopyNote, todaysNote);
});

test("the cloud names its sweep's feed, and anyone who reads the app gets the answer", () => {
  const main = read("apps/hosted/cloud/src/main.ts");
  assert.match(
    main,
    /const catalogFeedUrl = Option\.getOrUndefined\(\s*yield\* Config\.String\("EXECUTOR_CATALOG_URL"\)/,
  );
  assert.match(
    main,
    /HttpRouter\.provideRequest\(Layer\.succeed\(CatalogAppFeed, catalogFeedUrl\)\)/,
  );
  assert.match(
    read("apps/hosted/server/src/implementation/apps.ts"),
    /\.handle\("catalogUpdate", \(\{ params \}\) =>\s*Effect\.flatMap\(requireCurrentAppAccess\(params\.app, "read"\)/,
  );
  assert.match(
    read("apps/hosted/web/src/implementation/pages/app-detail.tsx"),
    /<AppSettings\s+app=\{current\}\s+copyNote=\{<CopiedFromNote app=\{current\} \/>\}/,
  );
});
