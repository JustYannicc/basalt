import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Logger, Schema } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const read = (path: string) => readFileSync(resolve(upstream, path), "utf8");
const implementation = "apps/hosted/server/src/implementation/";
const { breakingChanges, catalogEntryId, decideCatalogOffer, decideCatalogUpdate } = await load(
  `${implementation}catalog-app-updates.ts`,
);
const { updateCatalogApp } = await load(`${implementation}catalog-app-defaults.ts`);
const { applyCatalogUpdate } = await load(`${implementation}catalog-app-offers.ts`);
const { catalogDecision, reportCatalogApp } = await load(`${implementation}catalog-app-records.ts`);
const { AppVersionChanged } = await load("packages/sdk/src/contracts/version.ts");
const { SourceError } = await load("packages/sdk/src/contracts/source.ts");
const { AppInputs } = await load("packages/sdk/src/contracts/apps.ts");
const { frameworkPinRelease } = await load("packages/app-management/src/contracts/framework-pin.ts");

type Files = { path: string; content: string }[];
type Offer = { source: string; active: string; reconnect: number; reasons: string[]; touched: boolean };
type Outcome = { record: { version?: string; workspace?: string; applied?: string; offer: Offer }; active: string; deployed: boolean };
type Commit = { owner: string; app: string; expected: string | null; files: Files; message: string };
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
  /** A person's deploy lands after the last recheck, while the sweep's deploy runs. */
  deployDuringDeploy?: boolean;
  /** A person commits to the workspace while the sweep's deploy runs. */
  commitDuringDeploy?: boolean;
  /** Git storage fails the workspace commit. */
  commitFails?: boolean;
}) => {
  const versions = new Map((options.versions ?? [{ id: "v1", files: original }]).map((v) => [v.id, v.files]));
  const state = { active: options.active ?? "v1", builds: 0, deploys: 0, commits: [] as Commit[] };
  const workspace = { ...(options.workspace ?? { commit: "c1", files: original }) };
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
      source: ({ version }: { version?: string }) =>
        Effect.sync(() => ({ id: version ?? state.active, files: versions.get(version ?? state.active)! })),
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
      deploy: ({ files: deployed, expectedVersion }: { files: Files; expectedVersion?: string | null }) =>
        Effect.suspend(() => {
          if (options.deployDuringDeploy) {
            versions.set("v9", files("export default 'theirs';\n"));
            state.active = "v9";
          }
          if (options.commitDuringDeploy) Object.assign(workspace, { commit: "c9", files: files("draft") });
          // The SDK checks the expected version under the app's lock, right before activating.
          if (expectedVersion !== undefined && expectedVersion !== state.active)
            // The fixture's version IDs are not real ones, so the error names none.
            return Effect.fail(new AppVersionChanged({ app: "app_catalog", expected: null, current: null }));
          const id = `v${versions.size + 1}`;
          versions.set(id, deployed);
          state.deploys++;
          if (options.promote !== false) state.active = id;
          return Effect.succeed({ app: app(), version: { id } });
        }),
      commit: (input: Commit) =>
        Effect.suspend(() => {
          if (options.commitFails) return Effect.fail(new SourceError({ reason: "git" }));
          if (input.expected !== workspace.commit) return Effect.fail(new SourceError({ reason: "conflict" }));
          state.commits.push(input);
          Object.assign(workspace, { commit: `c${state.commits.length + 1}`, files: input.files });
          return Effect.succeed({ revision: { code: "code", commit: workspace.commit }, removed: { count: 0 } });
        }),
    },
  };
  const sweeping = (recorded?: Record<string, unknown>, links: Link[] = [], feed: Files = current) =>
    updateCatalogApp(executor, {
      organization: "org_team",
      owner: "organization:team",
      app: app(),
      files: feed,
      recorded,
      links: Effect.succeed(links),
    }) as Effect.Effect<Outcome | undefined>;
  const sweep = (recorded?: Record<string, unknown>, links: Link[] = [], feed: Files = current): Promise<Outcome> =>
    Effect.runPromise(sweeping(recorded, links, feed)) as Promise<Outcome>;
  const apply = (recorded?: Record<string, unknown>) =>
    Effect.runPromiseExit(
      applyCatalogUpdate(executor, { owner: "organization:team", app: app(), files: current, recorded }),
    );
  return { state, workspace, sweep, sweeping, apply };
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
    record: { version: "v2", workspace: "c2", applied: digest },
    active: "v2",
    deployed: true,
  });
  assert.equal(app.state.active, "v2");
  // The workspace's main gets the deployed files on the revision read, so "Deploy latest" keeps them.
  assert.equal(app.state.commits.length, 1);
  assert.deepEqual({ ...app.state.commits[0], message: "m" }, {
    owner: "organization:team", app: "app_catalog", expected: "c1", files: current, message: "m",
  });
  assert.ok(app.state.commits[0]!.message.length > 0);
  assert.deepEqual(app.workspace, { commit: "c2", files: current });
  // The recorded commit is clean: the next sweep of the same source records without deploying.
  const again = await app.sweep({ version: "v2", workspace: "c2", applied: digest });
  assert.deepEqual(again.record, { version: "v2", workspace: "c2", applied: digest });
  assert.equal(app.state.deploys, 1);
  assert.equal(app.state.commits.length, 1);
});

test("a person's deploy during the sweep's deploy is never recorded", async () => {
  const app = fixture({ deployDuringDeploy: true });
  // It lands after the last recheck; the deploy's expected version refuses to supersede it.
  assert.equal(await app.sweep({ version: "v1", workspace: "c1" }), undefined);
  assert.equal(app.state.builds, 1);
  assert.equal(app.state.deploys, 0);
  assert.equal(app.state.active, "v9");
  assert.equal(app.state.commits.length, 0);
});

test("a workspace that moved during the deploy keeps its commit and counts as touched", async () => {
  const app = fixture({ commitDuringDeploy: true });
  const outcome = await app.sweep({ version: "v1", workspace: "c1" });
  // The deploy stands and is the catalog's; the workspace's commit is not recorded clean.
  assert.deepEqual(outcome, { record: { version: "v2", applied: digest }, active: "v2", deployed: true });
  assert.equal(app.state.commits.length, 0);
  assert.deepEqual(app.workspace, { commit: "c9", files: files("draft") });
  // The next release's source is not deployed over the person's commit.
  assert.equal(await app.sweep(outcome.record, [], files("export default 3;\n")), undefined);
  assert.equal(app.state.deploys, 1);
  assert.equal(app.state.builds, 1);
});

test("a failed commit records no clean workspace while newer source runs", async () => {
  const app = fixture({ commitFails: true });
  // The deploy stands; the commit read holds the replaced source, so it is not recorded clean.
  assert.deepEqual(await app.sweep({ version: "v1", workspace: "c1" }), {
    record: { version: "v2", applied: digest }, active: "v2", deployed: true,
  });
  assert.equal(app.state.active, "v2");
});

test("a workspace clean only for its framework pin keeps the pin in its commit", async () => {
  const manifest = '{"name":"@catalog/example"}\n';
  const pinned = (body: string): Files => [
    { path: "index.ts", content: body },
    { path: "package.json", content: `${JSON.stringify({ name: "@catalog/example", dependencies: { apps: frameworkPinRelease } }, null, 2)}\n` },
  ];
  const plain = (body: string): Files => [{ path: "index.ts", content: body }, { path: "package.json", content: manifest }];
  const app = fixture({
    versions: [{ id: "v1", files: plain("export default 1;\n") }],
    workspace: { commit: "c1", files: pinned("export default 1;\n") },
  });
  // No recorded commit: only the pin makes the workspace clean.
  const outcome = await app.sweep(undefined, [], plain("export default 2;\n"));
  assert.equal(outcome.deployed, true);
  assert.equal(outcome.record.workspace, "c2");
  assert.deepEqual(app.state.commits.map(({ expected, files }) => ({ expected, files })), [
    { expected: "c1", files: pinned("export default 2;\n") },
  ]);
  // A heal keeps a pin committed on the source the earlier carry's deploy replaced.
  const drifted = fixture({
    versions: [{ id: "v1", files: plain("export default 1;\n") }, { id: "v2", files: plain("export default 2;\n") }],
    active: "v2",
    workspace: { commit: "c1", files: pinned("export default 1;\n") },
  });
  await drifted.sweep({ version: "v2", workspace: "c1" }, [], plain("export default 2;\n"));
  assert.deepEqual(drifted.state.commits.map(({ expected, files }) => ({ expected, files })), [
    { expected: "c1", files: pinned("export default 2;\n") },
  ]);
  assert.equal(drifted.state.deploys, 0);
});

test("a workspace that already holds the deployed files is not committed again", async () => {
  // A clean recorded commit can already hold the catalog's source. With no recorded version the
  // sweep never heals it back to the active source first.
  const app = fixture({ workspace: { commit: "c1", files: current } });
  const outcome = await app.sweep({ workspace: "c1" });
  assert.deepEqual(outcome.record, { version: "v2", workspace: "c1", applied: digest });
  assert.equal(app.state.commits.length, 0);
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
  // The recorded commit stays clean: it holds what the sweep's earlier update committed.
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
  // A person's deploy after the last recheck is never superseded, nor recorded.
  const raced = fixture({ deployDuringDeploy: true });
  assert.equal(await refused(raced.apply({ offer, workspace: "c1" })), "changed");
  assert.equal(raced.state.deploys, 0);
  assert.equal(raced.state.active, "v9");
  assert.equal(raced.state.commits.length, 0);
  // The feed moved on since the offer was evaluated: its newer source waits for the next sweep.
  const moved = fixture({});
  assert.equal(await refused(moved.apply({ offer: { ...offer, source: "0".repeat(64) } })), "changed");
  assert.equal(moved.state.deploys, 0);
  const app = fixture({});
  const exit = await app.apply({ version: "v1", workspace: "c1", offer });
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(exit.value, { record: { version: "v2", workspace: "c2", applied: digest }, active: "v2", deployed: true });
  assert.deepEqual(app.state.commits.map(({ expected, files }) => ({ expected, files })), [{ expected: "c1", files: current }]);
  assert.deepEqual(app.workspace, { commit: "c2", files: current });
  // A workspace that moved during the Update keeps its commit; the deploy is recorded without it.
  const moved2 = fixture({ commitDuringDeploy: true });
  const kept = await moved2.apply({ version: "v1", workspace: "c1", offer });
  assert.ok(Exit.isSuccess(kept));
  assert.deepEqual(kept.value.record, { version: "v2", applied: digest });
  assert.equal(moved2.state.commits.length, 0);
});

test("the SDK's deploy takes an expected version for an existing app only", () => {
  const decode = Schema.decodeUnknownExit(AppInputs.deploy);
  const source = [{ path: "index.ts", content: "export default 1;\n" }];
  assert.ok(Exit.isSuccess(decode({ owner: "organization:team", app: "app_catalog", files: source, expectedVersion: "dpl_1" })));
  assert.ok(Exit.isSuccess(decode({ owner: "organization:team", app: "app_catalog", commit: "a".repeat(40), expectedVersion: null })));
  assert.ok(Exit.isSuccess(decode({ owner: "organization:team", app: "app_catalog", files: source })));
  assert.ok(Exit.isFailure(decode({ owner: "organization:team", name: "CRM", files: source, expectedVersion: "dpl_1" })));
  // The deploy fails with AppVersionChanged before building, before migrations and under the
  // final app lock, before it activates.
  const deploy = read("packages/sdk/src/implementation/apps.ts");
  assert.match(deploy, /input\.expectedVersion === undefined \|\| app\.activeVersion === input\.expectedVersion\s*\? Effect\.void\s*: Effect\.fail\(\s*new AppVersionChanged\(/);
  assert.match(deploy, /const current = yield\* lockApp\(tx, \{ app: input\.app, owner: input\.owner \}\);\s*yield\* expectActive\(current\);\s*const deploySequence/);
  assert.match(deploy, /if \(before !== null && input\.expectedVersion !== undefined && requirements\.sql === true\)\s*yield\* transaction\(db, \(tx\) =>\s*lockApp\(tx, \{ app: before\.id, owner: input\.owner \}\)\.pipe\(Effect\.flatMap\(expectActive\)\),\s*\);\s*if \(requirements\.sql === true\)\s*yield\* runtime\.migrate/);
  assert.match(deploy, /if \(existing !== undefined\) yield\* expectActive\(existing\);\s*if \(existing !== undefined\) yield\* droppedMigrations\(tx, existing\.code\);\s*const createdAt[^\n]*\n\s*const promote/);
  assert.match(read("packages/sdk/src/contracts/apps.ts"), /HttpApiEndpoint\.post\("deploy"[\s\S]*?AppVersionChanged,\s*\],/);
});

/** The "Catalog app update" lines `work` logs. */
const logged = async <A>(work: Effect.Effect<A>) => {
  const lines: Record<string, unknown>[] = [];
  const capture = Logger.make((options) => {
    const [message, fields] = options.message as readonly unknown[];
    if (message === "Catalog app update") lines.push(fields as Record<string, unknown>);
  });
  const value = await Effect.runPromise(work.pipe(Effect.provide(Logger.layer([capture]))));
  return { lines, value };
};
const decisionLines = async (work: Effect.Effect<unknown>) => (await logged(work)).lines;

test("a drifted untouched install gets the active source committed once, and logs it", async () => {
  // The earlier carry deployed v2 without committing it; main still holds v1's source.
  const drifted = { versions: [{ id: "v1", files: original }, { id: "v2", files: current }], active: "v2" };
  const settled = { version: "v2", workspace: "c1", applied: digest };
  const app = fixture(drifted);
  const { lines, value } = await logged(app.sweeping(settled));
  assert.deepEqual(app.state.commits.map(({ expected, files }) => ({ expected, files })), [{ expected: "c1", files: current }]);
  assert.deepEqual(app.workspace, { commit: "c2", files: current });
  assert.deepEqual(lines, [{ app: "app_catalog", organization: "org_team", decision: "healed", version: "v2" }]);
  // The healed commit is recorded clean; nothing was deployed.
  assert.deepEqual(value?.record, { version: "v2", workspace: "c2", applied: digest });
  assert.equal(app.state.deploys, 0);
  // Healed once: the next sweep finds main holding the active source.
  assert.deepEqual((await logged(app.sweeping(value!.record))).lines, []);
  assert.equal(app.state.commits.length, 1);
  // A failed heal leaves the app alone, recording nothing.
  const failing = fixture({ ...drifted, commitFails: true });
  const failed = await logged(failing.sweeping(settled));
  assert.equal(failed.value, undefined);
  assert.deepEqual(failed.lines, []);
  assert.equal(failing.state.builds + failing.state.deploys, 0);
});

test("a person's deploy or unsaved edits are never healed", async () => {
  const versions = [{ id: "v1", files: original }, { id: "v2", files: current }];
  // The active version is not the recorded one: a person deployed it.
  const deployed = fixture({ versions, active: "v2" });
  const theirs = await logged(deployed.sweeping({ version: "v1", workspace: "c1", applied: digest }));
  assert.equal(deployed.state.commits.length, 0);
  assert.ok(!theirs.lines.some((line) => line.decision === "healed"));
  // Their version holds the catalog's source, so it is recorded, but main still holds what it
  // replaced: that commit is never recorded clean, so a later sweep cannot heal over it.
  assert.deepEqual(theirs.value?.record, { version: "v2", applied: digest });
  await deployed.sweep(theirs.value!.record);
  assert.equal(deployed.state.commits.length, 0);
  // The workspace moved past the recorded commit: someone's work.
  const edited = fixture({ versions, active: "v2", workspace: { commit: "c9", files: files("draft") } });
  const draft = await logged(edited.sweeping({ version: "v2", workspace: "c1", applied: digest }));
  assert.equal(edited.state.commits.length, 0);
  assert.deepEqual(edited.workspace, { commit: "c9", files: files("draft") });
  assert.ok(!draft.lines.some((line) => line.decision === "healed"));
});

test("every sweep decision logs one line with IDs only", async () => {
  const report = async (recorded: Record<string, unknown> | undefined, outcome: Outcome | undefined) =>
    decisionLines(
      reportCatalogApp(
        "org_team",
        "app_catalog",
        catalogDecision(recorded, outcome),
        outcome?.active ?? "v1",
        outcome?.record.offer,
      ),
    );
  const line = (decision: string, version: string, extra = {}) => [
    { app: "app_catalog", organization: "org_team", decision, version, ...extra },
  ];
  assert.deepEqual(await report(undefined, await fixture({}).sweep()), line("upgraded", "v2"));
  const breaking = { built: { crm: { provider: "provider-crm-v2", scope: "user", cardinality: "one" } } };
  const held = { version: "v1", workspace: "c1" };
  assert.deepEqual(
    await report(held, await fixture(breaking).sweep(held, [linked("a1")])),
    line("offered", "v1", { reasons: ["provider"], reconnect: 1 }),
  );
  const same = { versions: [{ id: "v1", files: current }], workspace: { commit: "c1", files: current } };
  const settled = { version: "v1", workspace: "c1", applied: digest };
  assert.deepEqual(await report(settled, await fixture(same).sweep(settled)), line("unchanged", "v1"));
  assert.deepEqual(await report(undefined, await fixture(same).sweep()), line("recorded", "v1"));
  const draft = fixture({ workspace: { commit: "c9", files: files("draft") } });
  assert.deepEqual(await report(held, await draft.sweep(held)), line("skipped", "v1"));
  // Each sweep and Update outcome passes through one report; nothing else logs the decision.
  const sweep = read(`${implementation}catalog-app-defaults.ts`);
  assert.equal(sweep.match(/reportCatalogApp\(/g)?.length, 1);
  assert.match(sweep, /Effect\.catchTags\(\{[\s\S]*?\}\),\s*Effect\.flatMap\(\(outcome: CatalogOutcome \| undefined\) =>\s*reportCatalogApp\(\s*organization,\s*app\.id,\s*catalogDecision\(recorded, outcome\),/);
  const update = read(`${implementation}catalog-app-offers.ts`);
  assert.equal(update.match(/reportCatalogApp\(/g)?.length, 2);
  assert.match(update, /saveCatalogRecord\(executor, organization, app\.id, recorded, outcome\);\s*yield\* reportCatalogApp\(organization, app\.id, "upgraded", outcome\.active\);/);
  assert.match(update, /error\._tag === "CatalogUpdateUnavailable"\s*\? reportCatalogApp\(organization, app\.id, "skipped", app\.activeVersion\)/);
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
