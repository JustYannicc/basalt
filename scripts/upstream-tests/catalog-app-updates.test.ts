import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const read = (path: string) => readFileSync(resolve(upstream, path), "utf8");
const { catalogEntryId, decideCatalogUpdate, reconnectCount } = await load(
  "apps/hosted/server/src/implementation/catalog-app-updates.ts",
);
const { updateCatalogApp } = await load(
  "apps/hosted/server/src/implementation/catalog-app-defaults.ts",
);

type Files = { path: string; content: string }[];
type Requirements = Record<string, { provider: string; scope: string; cardinality: string }>;
const files = (body: string): Files => [
  { path: "index.ts", content: body },
  { path: "package.json", content: '{"name":"@catalog/example","dependencies":{"apps":"1.0.0"}}\n' },
];
const original = files("export default 1;\n");
const current = files("export default 2;\n");
const crm = { crm: { provider: "provider-crm", scope: "user", cardinality: "one" } };

/** An in-memory app with retained versions, an active pointer and a Git workspace. */
const fixture = (options: {
  versions?: { id: string; files: Files; requirements?: Requirements }[];
  active?: string;
  workspace?: { commit: string; files: Files };
  deployRequirements?: Requirements;
}) => {
  const versions = new Map(
    (options.versions ?? [{ id: "v1", files: original }]).map((version) => [
      version.id,
      { files: version.files, requirements: version.requirements ?? crm },
    ]),
  );
  const state = { active: options.active ?? "v1", deploys: 0, activations: [] as unknown[] };
  const workspace = options.workspace ?? { commit: "c1", files: original };
  const app = () => ({
    id: "app_catalog",
    owner: "organization:team",
    activeVersion: state.active,
    copiedFrom: { reference: "https://basalt.example/catalog/apps/crm.json", name: "crm", commit: null },
    requirements: { accounts: versions.get(state.active)!.requirements },
  });
  const executor = {
    apps: {
      source: ({ version }: { version?: string }) => {
        const id = version ?? state.active;
        const found = versions.get(id);
        return found === undefined
          ? Effect.fail({ _tag: "VersionNotFound" })
          : Effect.succeed({ id, files: found.files });
      },
      workspace: () => Effect.succeed({ revision: { code: "code", commit: workspace.commit }, files: workspace.files }),
      versions: () => Effect.succeed([...versions.keys()].map((id) => ({ id }))),
      deploy: ({ files }: { files: Files }) =>
        Effect.sync(() => {
          const id = `v${versions.size + 1}`;
          versions.set(id, { files, requirements: options.deployRequirements ?? crm });
          state.active = id;
          state.deploys++;
          return { app: app() };
        }),
      activate: (input: { version: string; expectedVersion: string | null }) =>
        Effect.suspend(() => {
          state.activations.push(input);
          if (input.expectedVersion !== state.active)
            return Effect.fail({ _tag: "AppVersionChanged" });
          state.active = input.version;
          return Effect.succeed(app());
        }),
    },
  };
  const run = (
    recorded?: Record<string, unknown>,
    links: { requirement: string; scope: string; account: string; provider: string }[] = [],
  ) =>
    Effect.runPromise(
      updateCatalogApp(executor, {
        owner: "organization:team",
        app: app(),
        files: current,
        recorded,
        links: Effect.succeed(links),
      }),
    );
  return { state, run };
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
  const base = { versions: 1, active: "v1", recorded: undefined, unchanged: false, clean: true, offered: false };
  assert.equal(decideCatalogUpdate(base), "apply");
  assert.equal(decideCatalogUpdate({ ...base, unchanged: true, clean: false }), "record");
  assert.equal(decideCatalogUpdate({ ...base, clean: false }), "skip");
  assert.equal(decideCatalogUpdate({ ...base, offered: true }), "skip");
  assert.equal(decideCatalogUpdate({ ...base, versions: 2 }), "offer");
  assert.equal(decideCatalogUpdate({ ...base, versions: 2, recorded: { version: "v1" } }), "apply");
  assert.equal(decideCatalogUpdate({ ...base, versions: 3, active: "v3", recorded: { version: "v1", update: "v3" } }), "apply");
  assert.equal(reconnectCount(
    [
      { requirement: "crm", scope: "user", account: "a1", provider: "provider-old" },
      { requirement: "crm", scope: "user", account: "a1", provider: "provider-old" },
      { requirement: "gone", scope: "user", account: "a2", provider: "provider-crm" },
      { requirement: "crm", scope: "app", account: "a4", provider: "provider-crm" },
      { requirement: "crm", scope: "user", account: "a3", provider: "provider-crm" },
    ],
    crm,
  ), 3);
});

test("an untouched copy with no linked accounts moves to the catalog's current source", async () => {
  const app = fixture({});
  assert.deepEqual(await app.run(), { version: "v2", workspace: "c1" });
  assert.equal(app.state.active, "v2");
  assert.deepEqual(app.state.activations, []);
});

test("an update that would break linked accounts waits and keeps the previous version active", async () => {
  const app = fixture({
    deployRequirements: { crm: { provider: "provider-crm-v2", scope: "user", cardinality: "one" } },
  });
  const links = [
    { requirement: "crm", scope: "user", account: "a1", provider: "provider-crm" },
    { requirement: "crm", scope: "user", account: "a2", provider: "provider-crm" },
  ];
  assert.deepEqual(await app.run(undefined, links), {
    version: "v1",
    workspace: "c1",
    update: "v2",
    reconnect: 2,
  });
  assert.equal(app.state.active, "v1");
  assert.deepEqual(app.state.activations, [{ owner: "organization:team", app: "app_catalog", version: "v1", expectedVersion: "v2" }]);
  // The next release does not deploy the same waiting source again.
  assert.equal(await app.run({ version: "v1", workspace: "c1", update: "v2", reconnect: 2 }, links), undefined);
  assert.equal(app.state.deploys, 1);
});

test("a touched copy is never left on the catalog's version", async () => {
  const edited = files("export default 'mine';\n");
  const app = fixture({
    versions: [{ id: "v1", files: original }, { id: "v2", files: edited }],
    active: "v2",
    workspace: { commit: "c2", files: edited },
  });
  assert.deepEqual(await app.run({ version: "v1", workspace: "c1" }), {
    version: "v1",
    workspace: "c2",
    update: "v3",
    reconnect: 0,
  });
  assert.equal(app.state.active, "v2");
});

test("unchanged catalog files only record the active version", async () => {
  const app = fixture({ versions: [{ id: "v1", files: current }], workspace: { commit: "c1", files: current } });
  assert.deepEqual(await app.run({ version: "v0", update: "v9", reconnect: 1 }), { version: "v1", workspace: "c1" });
  assert.equal(app.state.deploys, 0);
});

test("unsaved workspace edits are skipped without a record", async () => {
  const app = fixture({ workspace: { commit: "c9", files: files("export default 'draft';\n") } });
  assert.equal(await app.run({ version: "v1", workspace: "c1" }), undefined);
  assert.equal(app.state.deploys, 0);
  assert.equal(app.state.active, "v1");
  // The commit the sweep last saw clean stays clean after its own deploys leave Git as it was.
  const deployed = fixture({
    versions: [{ id: "v1", files: original }, { id: "v2", files: files("export default 1.5;\n") }],
    active: "v2",
  });
  assert.deepEqual(await deployed.run({ version: "v2", workspace: "c1" }), { version: "v3", workspace: "c1" });
});

test("each release queues one catalog sweep per organization, run by its member jobs", () => {
  const steps = read("apps/hosted/cloud/src/infrastructure/data-steps.ts");
  assert.match(steps, /Config\.String\("EXECUTOR_CATALOG_URL"\)/);
  assert.match(steps, /queueCatalogAppUpdates\(feed\)/);
  const defaults = read("apps/hosted/server/src/implementation/catalog-app-defaults.ts");
  assert.match(defaults, /`\$\{catalogAppJobPrefix\}\$\{release\}`/);
  assert.match(read("apps/hosted/server/src/contracts/catalog-app-updates.ts"), /catalogAppJobPrefix = "basalt-catalog-apps:"/);
  assert.match(defaults, /select distinct on \(organization\.id\)/);
  assert.match(defaults, /member\.role in \('owner', 'admin'\)/);
  assert.match(defaults, /now\(\) \+ interval '15 minutes'/);
  assert.match(read("apps/hosted/server/src/implementation/catalog-app-release.ts"), /catalogAppRelease = "[a-f0-9]{40}"/);
  const provisioning = read("apps/hosted/server/src/implementation/provisioning.ts");
  assert.match(provisioning, /job\.id\.startsWith\(catalogAppJobPrefix\)/);
  assert.match(provisioning, /Effect\.provideService\(CatalogAppSweep, catalogOnly\)/);
  assert.match(read("apps/hosted/cloud/src/implementation/default-app.ts"), /withCatalogAppDefaults\(executor, catalogFeed, pools\)/);
  assert.match(read("apps/hosted/cloud/src/infrastructure/product.ts"), /cachedFeedClient\(apiOrigin, feedUrl\.value, egress\.client\)/);
  assert.match(read("apps/hosted/web/src/implementation/pages/app-source.tsx"), /Update available/);
});
