import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Cause, Effect, Exit } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const read = (path: string) => readFileSync(resolve(upstream, path), "utf8");
const implementation = "apps/hosted/server/src/implementation/";
const { breakingChanges, catalogEntryId, decideCatalogOffer, decideCatalogUpdate } = await load(
  `${implementation}catalog-app-updates.ts`,
);
const { updateCatalogApp } = await load(`${implementation}catalog-app-defaults.ts`);
const { applyCatalogUpdate } = await load(`${implementation}catalog-app-offers.ts`);

type Files = { path: string; content: string }[];
type Offer = { source: string; active: string; reconnect: number; reasons: string[]; touched: boolean };
type Outcome = { record: { version?: string; workspace?: string; applied?: string; offer: Offer }; active: string; deployed: boolean };
type Slot = { provider: string; scope: string; cardinality: string };
type Link = { requirement: string; scope: string; subject: string | null; account: string; provider: string };
const files = (body: string): Files => [
  { path: "index.ts", content: body },
  { path: "package.json", content: '{"name":"@catalog/example","dependencies":{"apps":"1.0.0"}}\n' },
];
const original = files("export default 1;\n");
const current = files("export default 2;\n");
/** The feed's source digest, as the sweep records it. */
const digest = createHash("sha256").update(JSON.stringify(current)).digest("hex");
const crm: Record<string, Slot> = { crm: { provider: "provider-crm", scope: "user", cardinality: "one" } };
const linked = (account: string, subject: string | null = "member-a"): Link => ({
  requirement: "crm", scope: subject === null ? "app" : "user", subject, account, provider: "provider-crm",
});

/** An in-memory app with retained versions, an active pointer, a Git workspace and a compiler. */
const fixture = (options: {
  versions?: { id: string; files: Files }[];
  active?: string;
  workspace?: { commit: string; files: Files };
  /** The active version's account slots. */
  accounts?: Record<string, Slot>;
  built?: Record<string, Slot>;
  /** A person's activation lands while the build runs, so the deploy is not promoted. */
  promote?: boolean;
  /** A person deploys their own edit while the build runs. */
  deployDuringBuild?: boolean;
}) => {
  const versions = new Map((options.versions ?? [{ id: "v1", files: original }]).map((v) => [v.id, v.files]));
  const state = { active: options.active ?? "v1", builds: 0, deploys: 0 };
  const workspace = options.workspace ?? { commit: "c1", files: original };
  const app = () => ({
    id: "app_catalog",
    name: "CRM",
    owner: "organization:team",
    activeVersion: state.active,
    copiedFrom: { reference: "https://basalt.example/catalog/apps/crm.json", name: "crm", commit: null },
    requirements: { accounts: options.accounts ?? crm },
  });
  const executor = {
    apps: {
      get: () => Effect.sync(app),
      source: () => Effect.succeed({ id: state.active, files: versions.get(state.active)! }),
      workspace: () => Effect.succeed({ revision: { code: "code", commit: workspace.commit }, files: workspace.files }),
      versions: () => Effect.succeed([...versions.keys()].map((id) => ({ id }))),
      build: () =>
        Effect.sync(() => {
          state.builds++;
          if (options.deployDuringBuild) {
            versions.set("v9", files("export default 'theirs';\n"));
            state.active = "v9";
          }
          return { requirements: { accounts: options.built ?? crm } };
        }),
      deploy: ({ files }: { files: Files }) =>
        Effect.sync(() => {
          const id = `v${versions.size + 1}`;
          versions.set(id, files);
          state.deploys++;
          if (options.promote !== false) state.active = id;
          return { app: app(), version: { id } };
        }),
    },
  };
  const sweep = (recorded?: Record<string, unknown>, links: Link[] = []): Promise<Outcome> =>
    Effect.runPromise(
      updateCatalogApp(executor, {
        owner: "organization:team",
        app: app(),
        files: current,
        recorded,
        links: Effect.succeed(links),
      }),
    );
  const apply = (recorded?: Record<string, unknown>) =>
    Effect.runPromiseExit(
      applyCatalogUpdate(executor, { owner: "organization:team", app: app(), files: current, recorded }),
    );
  return { state, sweep, apply };
};

test("only exact references into this deployment's feed are catalog copies", () => {
  const feed = "https://basalt.example/catalog/index.json";
  assert.equal(catalogEntryId("https://basalt.example/catalog/apps/crm.json", feed), "crm");
  assert.equal(catalogEntryId("https://basalt.example/catalog/apps/my%20crm.json", feed), "my crm");
  assert.equal(catalogEntryId("https://catalog.executor.sh/apps/crm.json", feed), undefined);
  assert.equal(catalogEntryId("https://basalt.example/catalog/apps/a/b.json", feed), undefined);
  assert.equal(catalogEntryId("https://example.com/apps/pool", feed), undefined);
  assert.equal(catalogEntryId(undefined, feed), undefined);
});

test("the decision follows the product rules", () => {
  assert.equal(decideCatalogUpdate({ unchanged: true, clean: false }), "record");
  assert.equal(decideCatalogUpdate({ unchanged: false, clean: false }), "skip");
  assert.equal(decideCatalogUpdate({ unchanged: false, clean: true }), "evaluate");
  const base = { versions: 1, active: "v1", recorded: undefined, breaking: false };
  assert.equal(decideCatalogOffer(base).decision, "apply");
  assert.equal(decideCatalogOffer({ ...base, breaking: true }).decision, "offer");
  assert.deepEqual(decideCatalogOffer({ ...base, versions: 2 }), { untouched: false, decision: "offer" });
  assert.equal(decideCatalogOffer({ ...base, versions: 2, recorded: { version: "v1" } }).decision, "apply");
});

test("breaking changes count accounts that stop working and name why", () => {
  const changed = { crm: { provider: "provider-crm-v2", scope: "user", cardinality: "one" } };
  assert.deepEqual(breakingChanges([linked("a1"), linked("a1", "member-b"), linked("a2")], crm, changed), {
    reconnect: 2,
    reasons: ["provider"],
  });
  assert.deepEqual(breakingChanges([linked("a1", null)], crm, crm), { reconnect: 1, reasons: ["scope"] });
  assert.deepEqual(breakingChanges([linked("a1")], crm, {}), { reconnect: 1, reasons: ["removed"] });
  // A new slot nobody linked holds the update back, though no linked account breaks.
  const added = { ...crm, ticket: { provider: "provider-ticket", scope: "app", cardinality: "one" } };
  assert.deepEqual(breakingChanges([linked("a1")], crm, added), { reconnect: 0, reasons: ["added"] });
  // A slot that becomes single keeps one account per linker.
  const many = { crm: { ...crm.crm, cardinality: "many" } };
  assert.deepEqual(breakingChanges([linked("a1"), linked("a2"), linked("a3"), linked("b1", "member-b")], many, crm), {
    reconnect: 2,
    reasons: ["cardinality"],
  });
  assert.deepEqual(breakingChanges([linked("a1"), linked("b1", "member-b")], many, crm), { reconnect: 0, reasons: [] });
});

test("an untouched copy no linked account breaks on moves to the catalog's current source", async () => {
  const app = fixture({});
  assert.deepEqual(await app.sweep(undefined, [linked("a1")]), {
    record: { version: "v2", workspace: "c1", applied: digest },
    active: "v2",
    deployed: true,
  });
  assert.equal(app.state.active, "v2");
});

test("a person's deploy during the build is never deployed over", async () => {
  const app = fixture({ deployDuringBuild: true });
  // Recorded as the catalog's own, so the sweep decides to apply before rechecking.
  assert.equal(await app.sweep({ version: "v1", workspace: "c1" }), undefined);
  assert.equal(app.state.builds, 1);
  assert.equal(app.state.deploys, 0);
  assert.equal(app.state.active, "v9");
});

test("an untouched copy whose recorded digest matches the feed is never redeployed", async () => {
  // Binary public files make stored and served files differ; the recorded digest decides.
  const app = fixture({});
  const outcome = await app.sweep({ version: "v1", workspace: "c1", applied: digest });
  assert.deepEqual(outcome.record, { version: "v1", workspace: "c1", applied: digest });
  assert.equal(outcome.deployed, false);
  assert.equal(app.state.builds, 0);
  assert.equal(app.state.deploys, 0);
  // A digest recorded for another version proves nothing about the active one.
  const touched = fixture({ versions: [{ id: "v1", files: original }, { id: "v2", files: original }], active: "v2" });
  assert.ok((await touched.sweep({ version: "v1", workspace: "c1", applied: digest })).record.offer);
  assert.equal(touched.state.deploys, 0);
});

test("a deploy that is not promoted is never recorded", async () => {
  const app = fixture({ promote: false });
  assert.equal(await app.sweep(), undefined);
  assert.equal(app.state.deploys, 1);
  assert.equal(app.state.active, "v1");
});

test("breaking updates are offered and never deployed", async () => {
  const app = fixture({ built: { crm: { provider: "provider-crm-v2", scope: "user", cardinality: "one" } } });
  const outcome = await app.sweep({ version: "v1", workspace: "c1" }, [linked("a1"), linked("a2", "member-b")]);
  assert.equal(app.state.deploys, 0);
  assert.equal(app.state.builds, 1);
  assert.equal(outcome.deployed, false);
  assert.equal(outcome.active, "v1");
  assert.deepEqual({ ...outcome.record.offer, source: "digest" }, {
    reconnect: 2, reasons: ["provider"], source: "digest", active: "v1", touched: false,
  });
  assert.match(outcome.record.offer.source, /^[a-f0-9]{64}$/);
  assert.equal(outcome.record.version, "v1");
});

test("new required slots and many-to-one slots hold the update back", async () => {
  const added = fixture({ built: { ...crm, ticket: { provider: "provider-ticket", scope: "app", cardinality: "one" } } });
  assert.deepEqual((await added.sweep()).record.offer.reasons, ["added"]);
  assert.equal(added.state.deploys, 0);
  // The active version takes many CRM accounts; the catalog's takes one, and a member linked two.
  const narrowed = fixture({ accounts: { crm: { ...crm.crm, cardinality: "many" } } });
  const held = await narrowed.sweep(undefined, [linked("a1"), linked("a2"), linked("b1", "member-b")]);
  assert.equal(narrowed.state.deploys, 0);
  assert.deepEqual(held.record.offer.reasons, ["cardinality"]);
  assert.equal(held.record.offer.reconnect, 1);
});

test("a touched copy is offered, never deployed", async () => {
  const edited = files("export default 'mine';\n");
  const app = fixture({
    versions: [{ id: "v1", files: original }, { id: "v2", files: edited }],
    active: "v2",
    workspace: { commit: "c2", files: edited },
  });
  const outcome = await app.sweep({ version: "v1", workspace: "c1" });
  assert.equal(app.state.deploys, 0);
  assert.equal(app.state.active, "v2");
  assert.equal(outcome.record.offer.touched, true);
  assert.equal(outcome.record.version, "v1");
});

test("unchanged catalog files only record the active version", async () => {
  const app = fixture({ versions: [{ id: "v1", files: current }], workspace: { commit: "c1", files: current } });
  const stale = { version: "v0", offer: { source: "x", active: "v1", reconnect: 1, reasons: ["provider"], touched: false } };
  assert.deepEqual((await app.sweep(stale)).record, { version: "v1", workspace: "c1", applied: digest });
  assert.equal(app.state.builds, 0);
  assert.equal(app.state.deploys, 0);
});

test("unsaved workspace edits are skipped without a record", async () => {
  const app = fixture({ workspace: { commit: "c9", files: files("export default 'draft';\n") } });
  assert.equal(await app.sweep({ version: "v1", workspace: "c1" }), undefined);
  assert.equal(app.state.builds, 0);
  assert.equal(app.state.deploys, 0);
  // The commit last seen clean stays clean after the sweep's own deploys leave Git as it was.
  const deployed = fixture({ versions: [{ id: "v1", files: original }, { id: "v2", files: files("1.5") }], active: "v2" });
  assert.equal((await deployed.sweep({ version: "v2", workspace: "c1" })).record.version, "v3");
});

test("a manager applies an offer only while it is current and the workspace is clean", async () => {
  const offer = { source: digest, active: "v1", reconnect: 1, reasons: ["provider"], touched: false };
  const failure = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { _tag: string; reason: string }) : undefined;
  const refused = async (exit: Promise<Exit.Exit<unknown, unknown>>) => {
    const error = failure(await exit);
    assert.equal(error?._tag, "CatalogUpdateUnavailable");
    return error.reason;
  };
  assert.equal(await refused(fixture({}).apply({ version: "v1" })), "none");
  assert.equal(await refused(fixture({}).apply({ offer: { ...offer, active: "v0" } })), "changed");
  const edited = fixture({ workspace: { commit: "c9", files: files("draft") } });
  assert.equal(await refused(edited.apply({ offer })), "edited");
  assert.equal(edited.state.deploys, 0);
  assert.equal(await refused(fixture({ promote: false }).apply({ offer, workspace: "c1" })), "changed");
  // The feed moved on since the offer was evaluated: its newer source waits for the next sweep.
  const moved = fixture({});
  assert.equal(await refused(moved.apply({ offer: { ...offer, source: "0".repeat(64) } })), "changed");
  assert.equal(moved.state.deploys, 0);
  const app = fixture({});
  const exit = await app.apply({ version: "v1", workspace: "c1", offer });
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(exit.value, { record: { version: "v2", workspace: "c1", applied: digest }, active: "v2", deployed: true });
});

test("each release queues one catalog sweep per organization, run by its member jobs", () => {
  const steps = read("apps/hosted/cloud/src/infrastructure/data-steps.ts");
  assert.match(steps, /Config\.String\("EXECUTOR_CATALOG_URL"\)/);
  assert.match(steps, /queueCatalogAppUpdates\(feed\)/);
  const queue = read(`${implementation}catalog-app-upgrades.ts`);
  assert.match(queue, /`\$\{catalogAppJobPrefix\}\$\{release\}`/);
  assert.match(queue, /select distinct on \(organization\.id\)/);
  assert.match(queue, /member\.role in \('owner', 'admin'\)/);
  assert.match(queue, /now\(\) \+ interval '15 minutes'/);
  assert.match(read("apps/hosted/server/src/contracts/catalog-app-updates.ts"), /catalogAppJobPrefix = "basalt-catalog-apps:"/);
  assert.match(read(`${implementation}catalog-app-release.ts`), /catalogAppRelease = "[a-f0-9]{40}"/);
  const provisioning = read(`${implementation}provisioning.ts`);
  assert.match(provisioning, /job\.id\.startsWith\(catalogAppJobPrefix\)/);
  assert.match(provisioning, /Effect\.provideService\(CatalogAppSweep, catalogOnly\)/);
  assert.match(read("apps/hosted/cloud/src/implementation/default-app.ts"), /withCatalogAppDefaults\(executor, catalogFeed, pools\)/);
  assert.match(read("apps/hosted/cloud/src/infrastructure/product.ts"), /cachedFeedClient\(apiOrigin, feedUrl\.value, egress\.client\)/);
  // Writes take the app's lock and recheck what they were decided from.
  const records = read(`${implementation}catalog-app-records.ts`);
  assert.match(records, /pg_advisory_xact_lock/);
  assert.match(records, /is not distinct from/);
  assert.match(records, /locked\.activeVersion !== outcome\.active/);
  // The Update button posts to the manager-only endpoint.
  assert.match(read("apps/hosted/server/src/contracts/apps.ts"), /HttpApiEndpoint\.post\("applyCatalogUpdate"[\s\S]*?\.annotate\(RequiredAction, "manage"\)/);
  assert.match(read("apps/hosted/server/src/implementation/apps.ts"), /\.handle\("applyCatalogUpdate", \(\{ params \}\) =>\s*Effect\.andThen\(appManagerOwner\(params\.app\)/);
  assert.match(read("apps/hosted/web/src/implementation/pages/app-source.tsx"), /Update available/);
});
