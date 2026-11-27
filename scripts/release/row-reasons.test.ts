import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore } from "alchemy/Artifacts";
import type * as AlchemyPlan from "alchemy/Plan";
import type { ResourceState } from "alchemy/State/ResourceState";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  carryTargets,
  changedFiles,
  deployedCommit,
  perReleaseFiles,
  type ChangedFiles,
} from "./changed-files.ts";
import { planDigest } from "./plan-check.ts";
import { changedRows } from "./plan-summary.ts";
import { planReasonLines, reasonLines, rowReasons, type ReasonInput } from "./row-reasons.ts";
import { calledRows, makePlan, productionRows } from "./test/plan-fixture.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const deployed = "d".repeat(40);
const changes = (...files: string[]): ChangedFiles => ({
  deployed,
  files: new Set(files),
  upstreamPin: false,
});
const provide: ReasonInput["provide"] = (effect) =>
  effect.pipe(
    Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
    Effect.provide(NodeServices.layer),
  );

type Planned = Awaited<ReturnType<typeof makePlan>>;
const reasons = (planned: Planned, changed: ChangedFiles | undefined) =>
  rowReasons({
    plan: planned.plan,
    rows: changedRows({ resources: rowsOf(planned.plan), summary: {}, native: planned.plan }),
    root,
    changed,
    artifacts: planned.artifacts,
    provide,
  });
/** The plan's rows as `Stack.plan` describes them, from the nodes alone. */
const rowsOf = (plan: AlchemyPlan.Plan) =>
  Object.entries(plan.resources).map(([fqn, node]) => ({
    fqn,
    resourceType: String((node as { resource?: { Type?: unknown } }).resource?.Type),
    action: node!.action,
    bindings: ((node as { bindings?: { sid: string; action: string }[] }).bindings ?? []).map(
      ({ sid, action }) => ({ sid, action }),
    ),
  }));

const withHash = (
  rows: Readonly<Record<string, unknown>>,
  fqn: string,
  hash: Record<string, unknown>,
) => {
  const row = rows[fqn] as { attr: { hash?: object } };
  return {
    ...rows,
    [fqn]: { ...row, attr: { ...row.attr, hash: { ...row.attr.hash, ...hash } } },
  } as unknown as Record<string, ResourceState>;
};

/** The tools Worker uploaded from this checkout, then planned again with State's bundle hash changed. */
async function workerPlan(context: TestContext) {
  const settled = await makePlan(context, {
    rows: { ...productionRows(), ...calledRows() },
    declared: { credentials: {} },
    settle: ["Api", "Catalog", "ArtifactsCredentials"],
  });
  return makePlan(context, {
    rows: withHash(settled.rows, "Api", { bundle: "f".repeat(64) }),
    declared: { credentials: {} },
  });
}

/** The database commands applied once, then planned again with each command's recorded key stale. */
async function commandPlan(context: TestContext) {
  const rows = productionRows();
  (rows.PoolWorker as unknown as { bindings: { sid: string; data: unknown }[] }).bindings.push({
    sid: "POOL_DATABASE_READY",
    data: { bindings: [{ type: "plain_text", name: "POOL_DATABASE_READY", text: "ready" }] },
  });
  delete rows.PoolDatabase;
  const settled = await makePlan(context, {
    rows,
    declared: { poolDatabase: {} },
    settle: ["RuntimeDatabaseBudget", "Migrations", "PoolDatabase"],
    commandRuns: [],
  });
  let stale: Record<string, ResourceState> = settled.rows as never;
  for (const fqn of ["Migrations", "PoolDatabase"])
    stale = withHash(stale, fqn, { input: "recorded" });
  return makePlan(context, { rows: stale, declared: { poolDatabase: {} } });
}

test("a command keyed on input files names its changed key files, or says none changed", async (context) => {
  const planned = await commandPlan(context);
  for (const fqn of ["Migrations", "PoolDatabase"])
    assert.equal(planned.plan.resources[fqn]?.action, "update", fqn);
  const changed = await reasons(
    planned,
    changes("scripts/release/test/plan-context/Dockerfile", "README.md"),
  );
  assert.ok(
    changed.includes(
      "Migrations: key files changed: scripts/release/test/plan-context/Dockerfile (1 of 1 key files)",
    ),
    changed.join("\n"),
  );
  // The pool database command's key is the files the stack declares, the lockfile among them.
  const pool = changed.find((line) => line.startsWith("PoolDatabase: "));
  assert.match(pool ?? "", /^PoolDatabase: no key file changed \((\d+) key files\)$/u);
  const again = await reasons(planned, changes("scripts/ensure-pool-database.ts", "brand.ts"));
  assert.ok(
    again.includes(
      "PoolDatabase: key files changed: brand.ts, scripts/ensure-pool-database.ts (2 of " +
        /\((\d+) key files\)/u.exec(pool!)![1] +
        " key files)",
    ),
    again.join("\n"),
  );
  assert.ok(again.includes("Migrations: no key file changed (1 key files)"), again.join("\n"));
});

test("a Worker names the changed files its bundle's source map reaches, or says none does", async (context) => {
  const planned = await workerPlan(context);
  assert.equal(planned.plan.resources.Api?.action, "update");
  const reached = await reasons(
    planned,
    changes("scripts/release/test/plan-worker.ts", "README.md"),
  );
  assert.ok(
    reached.includes(
      "Api: 1 changed file reaches this Worker: scripts/release/test/plan-worker.ts",
    ),
    reached.join("\n"),
  );
  const none = await reasons(planned, changes("README.md"));
  assert.ok(none.includes("Api: no changed file reaches this Worker"), none.join("\n"));
  assert.ok(!none.some((line) => line.includes("README.md")));
  // A dependency or build setting changes the bundle although no source map names it.
  const lock = await reasons(planned, changes("bun.lock", "README.md"));
  assert.ok(
    lock.includes(
      "Api: no changed source file reaches this Worker; dependencies or build configuration changed: bun.lock",
    ),
    lock.join("\n"),
  );
});

test("a Worker the provider alone changes names the bundle hash that differs, both shortened", async (context) => {
  const planned = await workerPlan(context);
  const lines = await reasons(planned, undefined);
  const computed = (planned.artifacts.get("Api")!.get("build") as { hash: string }).hash;
  assert.ok(
    lines.includes(
      `Api: planned by the provider's own diff: bundle differs: State ffffffffffff, computed ${computed.slice(0, 12)}`,
    ),
    lines.join("\n"),
  );
});

/** A Worker row the provider alone changes, as the planner leaves it, with the given props and State hashes. */
const providerOnly = (props: object, hash: Record<string, unknown>) =>
  ({
    resources: {
      Site: {
        action: "update",
        props,
        bindings: [],
        resource: { Type: "Cloudflare.Worker", LogicalId: "Site" },
        state: { resourceType: "Cloudflare.Worker", status: "created", props, attr: { hash } },
      },
    },
    deletions: {},
  }) as unknown as AlchemyPlan.Plan;
const row = {
  fqn: "Site",
  type: "Cloudflare.Worker",
  action: "update",
  changedProps: [],
  bindings: [],
};

test("an assets hash that differs is named with State's and the declared value, shortened", async () => {
  const plan = providerOnly(
    { assets: { directory: "site", hash: "a".repeat(64) } },
    { assets: "b".repeat(64) },
  );
  const lines = await rowReasons({
    plan,
    rows: [row],
    root,
    changed: undefined,
    artifacts: undefined,
    provide,
  });
  assert.ok(
    lines.includes(
      "Site: planned by the provider's own diff: assets differs: State bbbbbbbbbbbb, computed aaaaaaaaaaaa",
    ),
    lines.join("\n"),
  );
});

test("a vite input counts the changed files in the tree it covers and never names one", async (context) => {
  const tree = mkdtempSync(join(tmpdir(), "row-reasons-vite-"));
  context.after(() => rmSync(tree, { recursive: true, force: true }));
  const names = ["app/private-route-name.ts", "app/nested/release-only-file.ts", "shared/x.ts"];
  for (const name of names) {
    mkdirSync(dirname(join(tree, name)), { recursive: true });
    writeFileSync(join(tree, name), name);
  }
  const plan = providerOnly(
    { vite: { rootDir: join(tree, "app"), memo: { include: ["**/*"] } } },
    { input: "c".repeat(64), additionalWorkspaces: ["../shared"] },
  );
  const read = async (changed: ChangedFiles | undefined) =>
    (
      await rowReasons({ plan, rows: [row], root: tree, changed, artifacts: undefined, provide })
    ).join("\n");
  const some = await read(changes(...names, "bun.lock", "elsewhere/y.ts"));
  assert.match(
    some,
    /^Site: planned by the provider's own diff: a vite input, not recomputed here \(State input cccccccccccc\); 4 changed files lie in the tree it covers$/mu,
  );
  for (const name of [...names, "private-route-name", "release-only-file", tree])
    assert.equal(some.includes(name), false, name);
  assert.match(
    await read(changes("elsewhere/y.ts")),
    /no changed file lies in the tree it covers$/mu,
  );
  assert.match(await read(undefined), /the changed files are unknown$/mu);
});

test("reading the reasons leaves the plan, its rows and its digest as they were", async (context) => {
  const planned = await workerPlan(context);
  const twin = await workerPlan(context);
  const before = planDigest(planned.plan);
  const rows = JSON.stringify(
    changedRows({ resources: rowsOf(planned.plan), summary: {}, native: planned.plan }),
  );
  await reasons(planned, changes("scripts/release/test/plan-worker.ts"));
  assert.equal(planDigest(planned.plan), before);
  // The same recorded plan built again, with no reasons step: the same digest.
  assert.equal(planDigest(twin.plan), before);
  assert.equal(
    JSON.stringify(
      changedRows({ resources: rowsOf(planned.plan), summary: {}, native: planned.plan }),
    ),
    rows,
  );
});

test("without a deployed commit the changed files are unknown and no row names a file", async (context) => {
  const planned = await commandPlan(context);
  // The fixture's commands record no release commit, so State names none.
  assert.equal(deployedCommit(planned.plan), undefined);
  assert.equal(changedFiles(root, undefined, "HEAD"), undefined);
  assert.equal(changedFiles(root, "0".repeat(40), "HEAD"), undefined);
  const lines = await reasons(planned, undefined);
  assert.match(lines[0]!, /^Changed files unknown: /u);
  assert.ok(!lines.some((line) => /key files changed|reach/u.test(line)), lines.join("\n"));
});

const commandNode = (sha: string | undefined, status = "updated") => ({
  action: "noop",
  state: { resourceType: "Command.Exec", status, props: { env: sha ? { GITHUB_SHA: sha } : {} } },
});
const plannedWith = (...nodes: object[]) =>
  ({
    resources: Object.fromEntries(nodes.map((node, index) => [`Check${index}`, node])),
    deletions: {},
  }) as unknown as AlchemyPlan.Plan;

test("the deployed commit is the one every settled release command recorded, or unknown", () => {
  const a = "a".repeat(40);
  assert.equal(
    deployedCommit(plannedWith(commandNode(a), commandNode(a), commandNode(undefined))),
    a,
  );
  // Two commits recorded (an apply that stopped between them) or one still running: unknown.
  assert.equal(deployedCommit(plannedWith(commandNode(a), commandNode("b".repeat(40)))), undefined);
  assert.equal(deployedCommit(plannedWith(commandNode(a, "updating"))), undefined);
  // The commands finished and recorded the new commit, but another row the apply began did not:
  // that row still holds what came before, so no one commit describes State.
  for (const status of ["creating", "updating", "replacing", "replaced", "deleting"])
    assert.equal(
      deployedCommit(
        plannedWith(commandNode(a), {
          action: "update",
          state: { resourceType: "Cloudflare.Worker", status },
        }),
      ),
      undefined,
      status,
    );
  assert.equal(deployedCommit(plannedWith(commandNode("not-a-sha"))), undefined);
});

test("the changed files are git's, with each changed carry's files and the per-release ones", (context) => {
  const repo = mkdtempSync(join(tmpdir(), "row-reasons-git-"));
  context.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
    }).trim();
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  const patch = (target: string) =>
    `diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n--- a/not-a-header\n+x\n`;
  git("init", "-q");
  write("src/kept.ts", "1");
  write("patches/0001-carry.patch", patch("apps/one.ts"));
  git("add", ".");
  git("commit", "-qm", "one");
  const from = git("rev-parse", "HEAD");
  write("src/changed.ts", "2");
  write("patches/0001-carry.patch", patch("apps/two.ts"));
  git("add", ".");
  git("commit", "-qm", "two");
  const result = changedFiles(repo, from, git("rev-parse", "HEAD"));
  assert.deepEqual(
    [...(result?.files ?? [])].sort(),
    [
      ".upstream/apps/one.ts",
      ".upstream/apps/two.ts",
      ...perReleaseFiles,
      "patches/0001-carry.patch",
      "src/changed.ts",
    ].sort(),
  );
  assert.equal(result?.deployed, from);
  assert.equal(result?.upstreamPin, false);
});

test("a changed carry names only the files whose section really differs", () => {
  const section = (target: string, line: string, index = "1111111..2222222", at = "@@ -1 +1 @@") =>
    `diff --git a/${target} b/${target}\nindex ${index} 100644\n--- a/${target}\n+++ b/${target}\n${at}\n-old\n+${line}\n`;
  const before = section("apps/one.ts", "a") + section("apps/two.ts", "b");
  // Re-based: only the index and hunk offsets moved.
  const rebased =
    section("apps/one.ts", "a", "3333333..4444444", "@@ -40 +40 @@") +
    section("apps/two.ts", "b", "5555555..6666666", "@@ -7 +7 @@");
  assert.deepEqual(carryTargets(before, rebased), []);
  assert.deepEqual(
    carryTargets(before, section("apps/one.ts", "a") + section("apps/two.ts", "c")),
    ["apps/two.ts"],
  );
  // Added or retired: every file the one side changes.
  assert.deepEqual(carryTargets(undefined, before).sort(), ["apps/one.ts", "apps/two.ts"]);
  // Without git headers no section is known, so every file either side names counts.
  assert.deepEqual(carryTargets("--- a/x.ts\n+++ b/x.ts\n", "--- a/y.ts\n+++ b/y.ts\n").sort(), [
    "x.ts",
    "y.ts",
  ]);
});

test("assets the provider cannot read are named as changed, as its diff counts them", async () => {
  const plan = providerOnly(
    { assets: { directory: join(tmpdir(), "row-reasons-no-such-assets") } },
    { assets: "b".repeat(64) },
  );
  const lines = await rowReasons({
    plan,
    rows: [row],
    root,
    changed: undefined,
    artifacts: undefined,
    provide,
  });
  assert.ok(
    lines.includes(
      "Site: planned by the provider's own diff: assets not readable here, which the provider counts as changed (State bbbbbbbbbbbb)",
    ),
    lines.join("\n"),
  );
});

test("reasons that stall give way to a fixed line within their bound", async () => {
  const lines = await reasonLines(
    {
      plan: providerOnly({}, {}),
      rows: [row],
      root,
      changed: undefined,
      artifacts: undefined,
      provide: () => Effect.never,
    },
    50,
  );
  assert.deepEqual(lines, ["Why these rows plan: not read within 0.05 s; the plan is unaffected"]);
});

/** Every settled release command in the rows records the given commit, as each release's do. */
const releasedAt = (rows: Readonly<Record<string, unknown>>, sha: string) =>
  Object.fromEntries(
    Object.entries(rows).map(([fqn, value]) => {
      const state = value as { resourceType?: string; props?: { env?: Record<string, unknown> } };
      return [
        fqn,
        state.resourceType === "Command.Exec"
          ? { ...state, props: { ...state.props, env: { ...state.props?.env, GITHUB_SHA: sha } } }
          : value,
      ];
    }),
  ) as unknown as Record<string, ResourceState>;

test("the entry's reasons read a real plan's State and session and change neither", async (context) => {
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const built = await workerPlan(context);
  const planned = await makePlan(context, {
    rows: releasedAt(built.rows, head),
    declared: { credentials: {} },
  });
  assert.equal(deployedCommit(planned.plan), head);
  const session = Effect.runSync(
    Effect.context<FileSystem.FileSystem | Path.Path | AlchemyContext | ArtifactStore>().pipe(
      Effect.provideService(ArtifactStore, planned.artifacts),
      Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
      Effect.provide(NodeServices.layer),
    ),
  );
  const digest = planDigest(planned.plan);
  // Each entry by identity: a read that replaced or added a value would differ here.
  const stored = () =>
    [...planned.artifacts].flatMap(([fqn, entries]) =>
      [...entries].map(([key, value]) => [fqn, key, value] as const),
    );
  const before = stored();
  const rows = changedRows({ resources: rowsOf(planned.plan), summary: {}, native: planned.plan });
  const lines = await planReasonLines({
    snapshot: { native: planned.plan, session: { context: session as never } },
    rows,
    root,
    candidate: head,
  });
  assert.equal(lines[0], `Changed files since the deployed commit ${head.slice(0, 12)}: 0`);
  // The bundle came from the session's artifact store, so its source map was read.
  assert.ok(lines.includes("Api: no changed file reaches this Worker"), lines.join("\n"));
  assert.equal(planDigest(planned.plan), digest);
  const after = stored();
  assert.equal(after.length, before.length);
  after.forEach(([fqn, key, value], index) => {
    assert.equal(fqn, before[index]![0]);
    assert.equal(key, before[index]![1]);
    assert.equal(value, before[index]![2], `${fqn} ${key}`);
  });
});

/** A checkout of its own with the given files, and a Worker bundle whose source map names them. */
function bundledTree(context: TestContext, files: readonly string[]) {
  const tree = mkdtempSync(join(tmpdir(), "row-reasons-tree-"));
  context.after(() => rmSync(tree, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    writeFileSync(join(tree, file), file);
  }
  const map = { version: 3, sources: files.map((file) => join(tree, file)), mappings: "" };
  const artifacts = new Map([
    [
      "Site",
      new Map<string, unknown>([
        [
          "build",
          {
            hash: "e".repeat(64),
            files: [{ path: "worker.js.map", content: JSON.stringify(map) }],
          },
        ],
      ]),
    ],
  ]);
  return { tree, artifacts };
}

test("the per-release stamp is named apart from the changed files that reach a Worker", async (context) => {
  const stamp = perReleaseFiles[0]!;
  const { tree, artifacts } = bundledTree(context, [stamp, "src/worker.ts"]);
  const plan = providerOnly({}, {});
  const read = (changed: ChangedFiles) =>
    rowReasons({ plan, rows: [row], root: tree, changed, artifacts, provide });
  assert.ok(
    (await read(changes(stamp))).includes("Site: only the per-release stamp reaches this Worker"),
  );
  assert.ok(
    (await read(changes(stamp, "src/worker.ts"))).includes(
      "Site: 1 changed file reaches this Worker: src/worker.ts, plus the per-release stamp",
    ),
  );
  // A root lockfile can change any bundle; another client's package file cannot reach this one.
  const lines = await read(changes(stamp, "bun.lock", "clients/other/package.json"));
  assert.ok(
    lines.includes(
      "Site: only the per-release stamp reaches this Worker; dependencies or build configuration changed: bun.lock",
    ),
    lines.join("\n"),
  );
  const scoped = await read(changes("src/package.json", "clients/other/package.json"));
  assert.ok(
    scoped.includes(
      "Site: no changed source file reaches this Worker; dependencies or build configuration changed: src/package.json",
    ),
    scoped.join("\n"),
  );
});

test("a command that is new, or whose props changed, gets no key-file line; a build says what is not compared", async (context) => {
  const tree = mkdtempSync(join(tmpdir(), "row-reasons-command-"));
  context.after(() => rmSync(tree, { recursive: true, force: true }));
  writeFileSync(join(tree, "input.txt"), "1");
  const props = { cwd: tree, memo: { include: ["**/*"] } };
  const plan = {
    resources: {
      Fresh: { action: "create", props },
      Changed: { action: "update", props },
      Build: { action: "update", props },
    },
    deletions: {},
  } as unknown as AlchemyPlan.Plan;
  const rows = [
    { fqn: "Fresh", type: "Command.Exec", action: "create", changedProps: [], bindings: [] },
    { fqn: "Changed", type: "Command.Exec", action: "update", changedProps: ["env"], bindings: [] },
    { fqn: "Build", type: "Command.Build", action: "update", changedProps: [], bindings: [] },
  ];
  const lines = await rowReasons({
    plan,
    rows,
    root,
    changed: changes("README.md"),
    artifacts: undefined,
    provide,
  });
  assert.ok(lines.includes("Fresh: new, so it runs"), lines.join("\n"));
  assert.ok(!lines.some((line) => line.startsWith("Changed: ")), lines.join("\n"));
  assert.ok(
    lines.includes(
      "Build: no key file changed (1 key files); a build also plans when its output hash differs, which this entry does not compare",
    ),
    lines.join("\n"),
  );
});

test("a Worker with an inline script, or that lost its entry file, says so instead of a hash", async () => {
  const read = async (props: object, hash: Record<string, unknown>) =>
    (
      await rowReasons({
        plan: providerOnly(props, hash),
        rows: [row],
        root,
        changed: undefined,
        artifacts: undefined,
        provide,
      })
    ).find((line) => line.startsWith("Site: planned"));
  assert.equal(
    await read({ script: "export default {}" }, { bundle: "a".repeat(64) }),
    "Site: planned by the provider's own diff; an inline script's hash is not compared here",
  );
  assert.equal(
    await read({}, { bundle: "a".repeat(64) }),
    "Site: planned by the provider's own diff: it no longer has an entry file, while State still records a bundle",
  );
});

test("a binary change, a headerless section or a signature trailer falls back or is ignored as git means it", () => {
  const section = (target: string, line: string) =>
    `diff --git a/${target} b/${target}\nindex 1111111..2222222 100644\n--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-old\n+${line}\n`;
  const binary = (index: string) =>
    `diff --git a/logo.png b/logo.png\nindex ${index} 100644\nBinary files a/logo.png and b/logo.png differ\n`;
  // The two versions differ only in the binary's index line: every file is named.
  assert.deepEqual(carryTargets(binary("1111111..2222222"), binary("1111111..3333333")), [
    "logo.png",
  ]);
  // A format-patch signature names no file: only the git version under it changed.
  assert.deepEqual(
    carryTargets(
      `${section("apps/one.ts", "a")}-- \n2.50.0\n\n`,
      `${section("apps/one.ts", "a")}-- \n2.51.1\n`,
    ),
    [],
  );
  const headerless = `--- a/early.ts\n+++ b/early.ts\n@@ -1 +1 @@\n-x\n+y\n${section("apps/one.ts", "a")}`;
  assert.deepEqual(carryTargets(headerless, headerless).sort(), ["apps/one.ts", "early.ts"]);
});

test("changed files past their time bound are unknown, never a partial set", () => {
  assert.equal(changedFiles(root, "HEAD", "HEAD", 0), undefined);
});
