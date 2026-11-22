import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isResolved, stripUnresolved } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import type * as Plan from "alchemy/Plan";
import type { ResourceState } from "alchemy/State/ResourceState";
import { Cause, Effect, Exit } from "effect";
import { checkPlan, decodePlanPolicy, planDigest, PlanRefused, propChanges } from "./plan-check.ts";
import { decodeReleasePolicy } from "./policy.ts";
import {
  accountId,
  buildContext,
  calledRows,
  makePlan,
  pinnedImage,
  productionRows,
  recordedActionRow,
  retainedScratchRow,
  withCodeFromElsewhere,
  type PlanInput,
} from "./test/plan-fixture.ts";

// Every plan below is Alchemy's own: real resources and providers, Plan.make, production-shaped State.

const policy = (changes: Record<string, unknown> = {}) =>
  Effect.runPromise(
    decodePlanPolicy({
      mode: "release",
      protected: {
        fqns: [
          "PoolContainer",
          "PoolRuntime",
          "PoolRuntimeBlue",
          "PoolRuntimeGreen",
          "VaultAttachments",
          "PublicSiteWaitlist",
          "PoolObservationSecrets",
          "PoolProviderObservationToken",
          "ArtifactsCredentials",
        ],
        types: ["Cloudflare.Hyperdrive", "Planetscale.*"],
      },
      removals: [],
      // The fixture's root row is the old layer's, so it plans a hash-only update. Tests of other
      // rules admit that row as an image release would; the root's own tests use `rootUnchanged`.
      poolContainer: { fqn: "PoolContainer", image: pinnedImage, imageRelease: true },
      poolWorker: "PoolWorker",
      artifactsCredentials: "ArtifactsCredentials",
      allow: [],
      ...changes,
    }),
  );

const planned = (context: TestContext, input: PlanInput = {}) =>
  makePlan(context, { rows: productionRows(), ...input });

async function refused(plan: Plan.Plan, changes: Record<string, unknown> = {}) {
  const exit = await Effect.runPromiseExit(checkPlan(plan, await policy(changes)));
  assert.ok(Exit.isFailure(exit), "the plan was admitted");
  const error = Cause.squash(exit.cause);
  assert.ok(error instanceof PlanRefused, String(error));
  // A refusal is printed into a public log.
  assert.ok(!error.message.includes(accountId), error.message);
  assert.ok(!error.message.includes("synthetic-management-secret"), error.message);
  return {
    rules: error.violations.map((violation) => `${violation.rule} ${violation.fqn}`),
    message: error.message,
  };
}
const admitted = async (plan: Plan.Plan, changes: Record<string, unknown> = {}) =>
  (await Effect.runPromise(checkPlan(plan, await policy(changes)))).map(
    (change) => `${change.action} ${change.fqn}`,
  );

test("a pinned root container with the same digest is admitted as a hash-only update", async (context) => {
  const { plan, requests } = await planned(context);
  assert.equal(plan.resources.PoolContainer?.action, "update");
  assert.deepEqual(await admitted(plan), [
    "update ArtifactsCredentials",
    "update PoolContainer",
    "update PoolDatabase",
    "update PoolWorker",
  ]);
  // The container provider read the application from the local server while it diffed.
  assert.ok(requests.some((request) => request.includes("/containers/applications/")));
  assert.ok(requests.every((request) => request.startsWith("GET ")));
});

test("a Durable Object binding removed from a Worker is refused", async (context) => {
  const { plan } = await planned(context, { declared: { ledger: undefined } });
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["durable-object-class-removed PoolWorker"]);
  assert.match(
    message,
    /bindings\.PoolLedger: durable_object_namespace PoolLedger class PoolLedger -> absent/u,
  );
  assert.match(message, /deleted_classes for PoolLedger/u);
});

test("a changed class name on a Worker binding is refused", async (context) => {
  const { plan } = await planned(context, {
    declared: { ledger: { className: "PoolLedgerNext" } },
  });
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["durable-object-class-changed PoolWorker"]);
  assert.match(message, /bindings\.PoolLedger\.className: PoolLedger -> PoolLedgerNext/u);
});

test("a class moved onto a Worker that State does not record it on is refused", async (context) => {
  const { plan } = await planned(context, {
    declared: { newClass: { transferredFrom: "ArtifactsCredentials" } },
  });
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["durable-object-class-transferred PoolWorker"]);
  assert.match(message, /class PoolRuntimeBlue, and State records no namespace of it/u);
});

test("a move State already records on the Worker is history, in a code-only release too", async (context) => {
  // The upstream declares `transferredFrom` on classes that moved long ago; Alchemy keeps it inert.
  const moved = await planned(context, {
    declared: { ledger: { className: "PoolLedger", transferredFrom: "ArtifactsCredentials" } },
  });
  const { plan } = await planned(context);
  assert.deepEqual(await admitted(moved.plan), await admitted(plan));
  const codeOnly = await Effect.runPromiseExit(
    checkPlan(moved.plan, await policy({ mode: "code-only" })),
  );
  const violations = Exit.isFailure(codeOnly)
    ? (Cause.squash(codeOnly.cause) as PlanRefused).violations
    : [];
  assert.deepEqual(
    violations.filter((violation) => violation.rule === "durable-object-class-transferred"),
    [],
  );
});

test("a root attachment that resolves to another namespace is refused, path by path", async (context) => {
  const rows = productionRows();
  // State recorded another namespace than the one PoolWorker now hosts the class in.
  const root = rows.PoolContainer as unknown as { bindings: { sid: string; data: unknown }[] };
  root.bindings = [
    { sid: "PoolContainer", data: { durableObjects: { namespaceId: "namespace-elsewhere" } } },
  ];
  const { plan } = await planned(context, { rows });
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["pool-container-attachment-change PoolContainer"]);
  assert.match(message, /bindings\.PoolContainer\.durableObjects\.namespaceId/u);
  assert.match(message, /restart then refuses for good/u);
});

test("a root container declared by build context is refused", async (context) => {
  const { plan } = await planned(context, { declared: { container: { context: buildContext } } });
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, [
    "pool-container-built-from-source PoolContainer",
    "pool-container-image-not-pinned PoolContainer",
  ]);
  assert.match(message, /props\.context: absent -> declared/u);
  assert.match(message, /props\.image: …\/pool-root@sha256:e{64} \(pin\) -> absent/u);
});

test("a root container pinned to another digest or reconfigured is refused", async (context) => {
  const other = pinnedImage.replace(/e{64}$/u, "f".repeat(64));
  const repinned = await planned(context, { declared: { container: { image: other } } });
  assert.deepEqual((await refused(repinned.plan)).rules, [
    "pool-container-image-not-pinned PoolContainer",
  ]);
  const resized = await planned(context, { declared: { containerInstanceType: "standard" } });
  const { rules, message } = await refused(resized.plan);
  assert.deepEqual(rules, ["pool-container-configuration-change PoolContainer"]);
  assert.match(message, /props\.instanceType: basic -> standard/u);
});

test("replacing the vault attachments bucket is refused", async (context) => {
  const { plan } = await planned(context, { declared: { bucketJurisdiction: "default" } });
  assert.equal(plan.resources.VaultAttachments?.action, "replace");
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["protected-resource-destroyed VaultAttachments"]);
  assert.match(message, /props\.jurisdiction: eu -> default/u);
});

const scratchReplace = [
  {
    fqn: "ScratchRecords",
    type: "Cloudflare.R2.Bucket",
    action: "replace",
    reason: "reviewed: the scratch bucket moves jurisdiction",
  },
];

test("replacing an unprotected resource is refused in every mode, naming what forced it", async (context) => {
  const rows = { ...productionRows(), ScratchRecords: retainedScratchRow() };
  const { plan } = await planned(context, { rows, declared: { scratchJurisdiction: "default" } });
  assert.equal(plan.resources.ScratchRecords?.action, "replace");
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["unreviewed-replace ScratchRecords"]);
  assert.match(
    message,
    /\[unreviewed-replace\] ScratchRecords \(Cloudflare\.R2\.Bucket\) replace/u,
  );
  assert.match(message, /\$resource: recorded -> replaced by a new one/u);
  assert.match(message, /props\.jurisdiction: eu -> default/u);
  // An allow entry is not a reviewed replace: code-only and the cutover refuse it too.
  const allow = [{ fqn: "ScratchRecords", action: "replace" }];
  for (const mode of ["code-only", "cutover-classes"])
    assert.ok(
      (await refused(plan, { mode, allow })).rules.includes("unreviewed-replace ScratchRecords"),
      mode,
    );
  // A reviewed entry with the wrong action or type does not admit it.
  for (const entry of [
    { ...scratchReplace[0], action: "delete" },
    { ...scratchReplace[0], type: "Cloudflare.D1Database" },
  ])
    assert.deepEqual((await refused(plan, { removals: [entry] })).rules, [
      "unreviewed-replace ScratchRecords",
    ]);
  assert.ok(
    (await admitted(plan, { removals: scratchReplace })).includes("replace ScratchRecords"),
  );
});

test("a protected resource's replace is refused even when listed in removals", async (context) => {
  // The root's row lost its attachment binding: Alchemy recreates the application to attach it.
  const rows = productionRows();
  (rows.PoolContainer as { bindings: unknown[] }).bindings = [];
  const { plan } = await planned(context, { rows });
  assert.equal(plan.resources.PoolContainer?.action, "replace");
  const removals = [
    { fqn: "PoolContainer", type: "Cloudflare.Container", action: "replace", reason: "attempted" },
  ];
  const { rules, message } = await refused(plan, { removals });
  assert.deepEqual(rules, ["protected-resource-destroyed PoolContainer"]);
  assert.match(message, /replaced by a new one/u);
});

test("a destroy plan is refused", async (context) => {
  const { plan } = await planned(context, { destroy: true });
  assert.equal(plan.destroy, true);
  const { rules } = await refused(plan);
  assert.equal(rules[0], "destroy-plan (plan)");
  assert.ok(rules.includes("protected-resource-destroyed PoolContainer"));
});

test("a plain Worker binding removed from a Worker is refused", async (context) => {
  const { plan } = await planned(context, { declared: { vaultBinding: false } });
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["worker-binding-removed PoolWorker"]);
  assert.match(message, /bindings\.VAULT: r2_bucket VAULT -> absent/u);
  // A recorded binding row that carries no wire bindings is still a removal.
  const rows = productionRows();
  (rows.PoolWorker as { bindings: unknown[] }).bindings.push({ sid: "LegacyRoute", data: {} });
  const legacy = await refused((await planned(context, { rows })).plan);
  assert.deepEqual(legacy.rules, ["worker-binding-removed PoolWorker"]);
  assert.match(legacy.message, /bindings\.LegacyRoute: present -> absent/u);
});

test("a root container that State lost is refused: created, and attached anew", async (context) => {
  const rows = productionRows();
  delete (rows as Partial<typeof rows>).PoolContainer;
  const { plan } = await planned(context, { rows });
  assert.equal(plan.resources.PoolContainer?.action, "create");
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, [
    "pool-container-lifecycle PoolContainer",
    // With no recorded props, every declared prop is a change.
    "pool-container-configuration-change PoolContainer",
    "pool-container-attachment-change PoolContainer",
  ]);
  assert.match(message, /\$resource: recorded -> create/u);
  assert.match(message, /bindings\.PoolContainer: absent -> present/u);
});

test("an undeclared action row is refused until its removal is reviewed", async (context) => {
  const rows = { ...productionRows(), OldMigration: recordedActionRow("OldMigration") };
  const { plan } = await planned(context, { rows });
  assert.ok(plan.actionDeletions.OldMigration);
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["unreviewed-removal OldMigration"]);
  assert.match(message, /OldMigration \(Release\.Migration\) delete/u);
  const removals = [
    { fqn: "OldMigration", type: "Release.Migration", action: "delete", reason: "step retired" },
  ];
  assert.ok((await admitted(plan, { removals })).includes("delete OldMigration"));
});

test("an undeclared retained row is refused until its removal is reviewed", async (context) => {
  const rows = { ...productionRows(), ScratchRecords: retainedScratchRow() };
  const { plan } = await planned(context, { rows });
  assert.equal(plan.deletions.ScratchRecords?.action, "orphaned");
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["unreviewed-removal ScratchRecords"]);
  assert.match(message, /\$resource: recorded \(retain\) -> orphaned/u);
  const removals = [
    {
      fqn: "ScratchRecords",
      type: "Cloudflare.R2.Bucket",
      action: "orphaned",
      reason: "reviewed in the first full release",
    },
  ];
  assert.ok((await admitted(plan, { removals })).includes("orphaned ScratchRecords"));
});

test("a resource renamed from a recorded row is refused", async (context) => {
  const rows = { ...productionRows(), ScratchRecords: retainedScratchRow() };
  const { plan } = await planned(context, { rows, declared: { renamedScratch: true } });
  assert.deepEqual(plan.resources.ScratchArchive?.renamedFrom, ["ScratchRecords"]);
  const { rules, message } = await refused(plan);
  assert.deepEqual(rules, ["resource-renamed ScratchArchive"]);
  assert.match(message, /\$fqn: ScratchRecords -> ScratchArchive/u);
});

test("a resource is protected by its type, exactly or by prefix", async (context) => {
  const rows = { ...productionRows(), ScratchRecords: retainedScratchRow() };
  const { plan } = await planned(context, { rows });
  const fqns = ["PoolContainer"];
  // Protected wins alone: listing it in `removals` could not admit it, so that fix is not offered.
  for (const types of [["Cloudflare.R2.Bucket"], ["Cloudflare.R2.*"]])
    assert.deepEqual((await refused(plan, { protected: { fqns, types } })).rules, [
      "protected-resource-destroyed ScratchRecords",
    ]);
  assert.deepEqual((await refused(plan, { protected: { fqns, types: ["Cloudflare.R2"] } })).rules, [
    "unreviewed-removal ScratchRecords",
  ]);
});

test("a protected row cannot be listed away", async (context) => {
  const { plan } = await planned(context, { declared: { observationStore: false } });
  const removals = [
    {
      fqn: "PoolObservationSecrets",
      type: "Cloudflare.SecretsStore",
      action: "orphaned",
      reason: "attempted",
    },
  ];
  assert.deepEqual((await refused(plan, { removals })).rules, [
    "protected-resource-destroyed PoolObservationSecrets",
  ]);
});

test("deleting an undeclared Command row is admitted", async (context) => {
  const { plan } = await planned(context, { declared: { databaseCommand: false } });
  assert.equal(plan.deletions.PoolDatabase?.action, "delete");
  assert.ok((await admitted(plan)).includes("delete PoolDatabase"));
});

const cutover = {
  mode: "cutover-classes",
  include: ["PoolWorker"],
  allow: [
    { fqn: "PoolWorker", action: "update" },
    { fqn: "PoolContainer", action: "update" },
  ],
};
const filtered = { include: ["PoolWorker"], settle: ["ArtifactsCredentials"] };

test("the cutover is admitted when its changes equal the reviewed allow-list", async (context) => {
  const { plan } = await planned(context, { ...filtered, declared: { newClass: true } });
  assert.equal(plan.resources.ArtifactsCredentials?.action, "noop");
  const created = plan.resources.PoolWorker?.bindings.filter(
    (binding) => binding.action === "create",
  );
  assert.deepEqual(
    created?.map((binding) => binding.sid),
    ["PoolRuntimeBlue"],
  );
  assert.deepEqual(await admitted(plan, cutover), ["update PoolContainer", "update PoolWorker"]);
});

test("the cutover is refused for one change outside the allow-list, or one missing from it", async (context) => {
  const { plan } = await planned(context, {
    ...filtered,
    declared: { newClass: true, bucketStorageClass: "InfrequentAccess" },
  });
  const { rules, message } = await refused(plan, cutover);
  assert.deepEqual(rules, ["outside-cutover-classes VaultAttachments"]);
  assert.match(message, /\$action: noop -> update/u);
  const expected = [...cutover.allow, { fqn: "PublicSiteWaitlist", action: "update" }];
  const exact = await planned(context, { ...filtered, declared: { newClass: true } });
  assert.deepEqual((await refused(exact.plan, { ...cutover, allow: expected })).rules, [
    "outside-cutover-classes PublicSiteWaitlist",
  ]);
});

test("the cutover is refused while the artifacts credentials Worker would upload", async (context) => {
  const { plan } = await planned(context, {
    include: ["PoolWorker"],
    declared: { newClass: true },
  });
  assert.equal(plan.resources.ArtifactsCredentials?.action, "update");
  // Listing the Worker in the allow-list does not admit it.
  const allow = [...cutover.allow, { fqn: "ArtifactsCredentials", action: "update" }];
  assert.deepEqual((await refused(plan, { ...cutover, allow })).rules, [
    "artifacts-credentials-not-noop ArtifactsCredentials",
  ]);
});

test("a code-only release is admitted without, and refused with, a new binding", async (context) => {
  const codeOnly = { mode: "code-only", include: ["PoolWorker"] };
  const code = await planned(context, filtered);
  assert.deepEqual(await admitted(code.plan, codeOnly), [
    "update PoolContainer",
    "update PoolWorker",
  ]);
  const bound = await planned(context, { ...filtered, declared: { newClass: true } });
  const { rules, message } = await refused(bound.plan, codeOnly);
  assert.deepEqual(rules, ["code-only-binding-change PoolWorker"]);
  assert.match(
    message,
    /bindings\.PoolRuntimeBlue: absent -> durable_object_namespace PoolRuntimeBlue/u,
  );
  // A whole-stack code release: every changed Worker's code plus the release's migration command.
  const full = await planned(context, { settle: ["ArtifactsCredentials"] });
  assert.ok((await admitted(full.plan, { mode: "code-only" })).includes("update PoolDatabase"));
  // The bulk-import store's Worker moves only when a policy names it.
  const unsettled = await planned(context);
  assert.ok(
    (await refused(unsettled.plan, { mode: "code-only" })).rules.includes(
      "outside-code-only ArtifactsCredentials",
    ),
  );
  await admitted(unsettled.plan, {
    mode: "code-only",
    allow: [{ fqn: "ArtifactsCredentials", action: "update" }],
  });
});

// The bulk-import store's Worker in production's forms: the tools Worker it calls, the model
// database connection, a secret, a redacted value that carries the release's version and a JSON
// value. Its State rows are the ones Alchemy's own apply records for a declaration.
const allowance = (codeOnly: Record<string, unknown> = {}, also: readonly object[] = []) => ({
  mode: "code-only",
  allow: [
    {
      fqn: "ArtifactsCredentials",
      action: "update",
      codeOnly: {
        references: [
          { name: "TOOLS_SERVICE", resource: "Api" },
          { name: "POOL_AUTH_DATABASE", resource: "PoolModelDatabaseConnection" },
          { name: "VAULT", resource: "VaultAttachments" },
        ],
        values: [{ name: "EXECUTOR_TELEMETRY", fields: ["version"], why: "the release's version" }],
        why: "skew",
        ...codeOnly,
      },
    },
    ...also,
  ],
});
type StateRows = Readonly<Record<string, ResourceState>>;
type Declared = NonNullable<PlanInput["declared"]>;
type Credentials = NonNullable<Declared["credentials"]>;
type StoreProps = { main: string; env: Record<string, Record<string, unknown>> };
type RowData = Record<string, unknown> & { bindings: Record<string, unknown>[] };
type StoreRow = { sid: string; action: string; data: RowData };
type Planned = {
  plan: Plan.Plan;
  /** The store's node. */
  node: {
    action: string;
    props: { main: string; env: Record<string, unknown> };
    bindings: StoreRow[];
  };
  row: (sid: string) => StoreRow;
};
const storeWorkers = ["Api", "Catalog", "ArtifactsCredentials"];
const onlyStore = ["ArtifactsCredentials"];
const store = (rows: StateRows) =>
  rows.ArtifactsCredentials as unknown as {
    props: StoreProps;
    bindings: { sid: string; data: RowData }[];
  };
const attributes = (rows: StateRows, fqn: string) =>
  (rows[fqn] as unknown as { attr: Record<string, unknown> }).attr;

// Changes to the store's State row. Copied by spread: a clone unwraps secrets.
const withStore = (
  rows: StateRows,
  change: (row: ReturnType<typeof store>) => object,
): StateRows => ({
  ...rows,
  ArtifactsCredentials: { ...store(rows), ...change(store(rows)) } as unknown as ResourceState,
});
/** One recorded `env` entry changed. */
const entry =
  (
    name: string,
    change: (value: Record<string, unknown>, rows: StateRows) => Record<string, unknown>,
  ) =>
  (rows: StateRows) =>
    withStore(rows, ({ props }) => ({
      props: { ...props, env: { ...props.env, [name]: change(props.env[name] ?? {}, rows) } },
    }));
/** One recorded binding row changed. */
const row =
  (sid: string, change: (data: RowData, rows: StateRows) => unknown) => (rows: StateRows) =>
    withStore(rows, ({ bindings }) => ({
      bindings: bindings.map((binding) =>
        binding.sid === sid ? { ...binding, data: change(binding.data, rows) } : binding,
      ),
    }));
/** Every wire entry of a recorded row changed. */
const wireEntry =
  (change: (wire: Record<string, unknown>, rows: StateRows) => Record<string, unknown>) =>
  (data: RowData, rows: StateRows) => ({
    ...data,
    bindings: data.bindings.map((wire) => change(wire, rows)),
  });
const withoutEntry = (name: string) => (rows: StateRows) =>
  withStore(rows, ({ props, bindings }) => ({
    props: {
      ...props,
      env: Object.fromEntries(Object.entries(props.env).filter(([key]) => key !== name)),
    },
    bindings: bindings.filter((binding) => binding.sid !== name),
  }));
const each =
  (...changes: ((rows: StateRows) => StateRows)[]) =>
  (rows: StateRows) =>
    changes.reduce((state, change) => change(state), rows);
const recordedMain = (main: string) => (rows: StateRows) =>
  withStore(rows, ({ props }) => ({ props: { ...props, main } }));
/** State holds another Worker under the tools entry, in the entry and in its binding row. */
const callsCatalog = each(
  entry("TOOLS_SERVICE", (_value, rows) => ({ ...attributes(rows, "Catalog") })),
  row(
    "TOOLS_SERVICE",
    wireEntry((wire, rows) => ({ ...wire, service: attributes(rows, "Catalog").workerName })),
  ),
);
const otherConnection = "5".repeat(32);
const otherConnectionRow = row(
  "POOL_AUTH_DATABASE",
  wireEntry((wire) => ({ ...wire, id: otherConnection })),
);
const otherConnectionEntry = entry("POOL_AUTH_DATABASE", (value) => ({
  ...value,
  hyperdriveId: otherConnection,
}));
const withoutLocalCopy = ({ hyperdrives: _none, ...data }: RowData) => data;
const olderLocalCopy = (data: RowData) => ({
  ...data,
  hyperdrives: Object.fromEntries(
    Object.entries(data.hyperdrives as Record<string, object>).map(([id, origin]) => [
      id,
      { ...origin, host: "older-host.invalid" },
    ]),
  ),
});
const secondWireEntry = (data: RowData) => ({
  ...data,
  bindings: [...data.bindings, { type: "plain_text", name: "MODE", text: "before" }],
});
const otherBucket = "basalt-production-otherbucket";
/** An earlier release moved the connection to this host and left the store alone. */
const movedHost = "another-host.invalid";
const connectionMovedEarlier = (rows: StateRows): StateRows => {
  const connection = rows.PoolModelDatabaseConnection as unknown as {
    props: { origin: object };
    attr: { origin: object };
  };
  return {
    ...rows,
    PoolModelDatabaseConnection: {
      ...connection,
      props: { ...connection.props, origin: { ...connection.props.origin, host: movedHost } },
      attr: { ...connection.attr, origin: { ...connection.attr.origin, host: movedHost } },
    } as unknown as ResourceState,
  };
};
/**
 * An apply that stopped at the store's upload. Alchemy wrote the generation it was applying into
 * State first and keeps the last finished one under `old`; either may be what is live.
 */
const storeInterrupted = (unfinished: StateRows, finished: StateRows): StateRows => ({
  ...unfinished,
  ArtifactsCredentials: {
    ...store(unfinished),
    status: "updating",
    old: finished.ArtifactsCredentials,
  } as unknown as ResourceState,
});

// The rows of what the store refers to are other rules' to admit; these name them for a case.
const database = [{ fqn: "PoolModelDatabaseConnection", action: "update" }];
const bucket = [{ fqn: "VaultAttachments", action: "update" }];
/** The connection's origin moves in this plan, as it does on a test stage, so it updates. */
const connectionMoves: Credentials = { databaseHost: movedHost };
const bucketMoves: Declared = { bucketStorageClass: "InfrequentAccess" };
const named = (name: string) => [{ name, fields: ["version"], why: "a reason" }];
const toolsOnly = { references: [{ name: "TOOLS_SERVICE", resource: "Api" }] };
const TOOLS = /props\.env\.TOOLS_SERVICE/u;
const TOOLS_ROW = /bindings\.TOOLS_SERVICE: update/u;
const DATABASE = /props\.env\.POOL_AUTH_DATABASE/u;
const DATABASE_ROW = /bindings\.POOL_AUTH_DATABASE: update/u;
const TELEMETRY = /props\.env\.EXECUTOR_TELEMETRY: <redacted> -> <redacted>/u;
const TELEMETRY_ROW = /bindings\.EXECUTOR_TELEMETRY: update/u;
const SECRET = /props\.env\.POOL_APP_SIGNING_KEY: <redacted> -> <redacted>/u;

// What the real planner makes of a declaration, asserted before the verdict.
const waits = (planned: Planned, name: string, resource: string) => {
  assert.equal(planned.plan.resources[resource]?.action, "update");
  assert.equal(isResolved(planned.node.props.env[name]), false);
  assert.ok(Output.isResourceExpr(planned.node.props.env[name]));
};
const known = (planned: Planned, name: string, resource: string) => {
  assert.equal(planned.plan.resources[resource]?.action, "noop");
  assert.ok(isResolved(planned.node.props.env[name]));
};
const changedRows = (planned: Planned) =>
  planned.node.bindings.filter((binding) => binding.action !== "noop").map(({ sid }) => sid);
/** The connection updates: the entry is the connection, and its row waits in one key only. */
const databaseWaits = (planned: Planned) => {
  waits(planned, "POOL_AUTH_DATABASE", "PoolModelDatabaseConnection");
  const { action, data } = planned.row("POOL_AUTH_DATABASE");
  assert.equal(action, "update");
  assert.ok(isResolved(data.bindings));
  assert.deepEqual(
    Object.keys(data).filter((key) => !isResolved(data[key])),
    ["hyperdrives"],
  );
};
/** The connection is unchanged, so its row is known, and the planner still marks it changed. */
const databaseRowDiffers = (planned: Planned) => {
  known(planned, "POOL_AUTH_DATABASE", "PoolModelDatabaseConnection");
  const { action, data } = planned.row("POOL_AUTH_DATABASE");
  assert.equal(action, "update");
  assert.ok(isResolved(data));
};
const bucketWaits = (planned: Planned) => {
  waits(planned, "VAULT", "VaultAttachments");
  const { action, data } = planned.row("VAULT");
  assert.equal(action, "update");
  // The wire entry holds the bucket's jurisdiction, which is not known while the bucket updates.
  assert.equal(isResolved(data.bindings), false);
};
/** The store's State row is left by an interrupted apply, and the planner calls the row unchanged. */
const unchangedForThePlanner = (sid: string) => (planned: Planned) => {
  assert.equal(planned.node.action, "update");
  assert.equal(planned.row(sid).action, "noop");
};

const healingPlan = [...storeWorkers, "PoolWorker"];
/** The store, the tools Worker and the pool Worker all update; the tools entry is not known yet. */
const healing = (planned: Planned) => {
  assert.equal(planned.node.action, "update");
  assert.equal(planned.plan.resources.PoolWorker?.action, "update");
  waits(planned, "TOOLS_SERVICE", "Api");
};
/** The forms in which State can hold local development's copy of the connection's origin. */
const localCopyForms = [
  ["no", withoutLocalCopy],
  ["an undefined", (data: RowData) => ({ ...data, hyperdrives: undefined })],
  ["an empty", (data: RowData) => ({ ...data, hyperdrives: {} })],
  ["an older", olderLocalCopy],
] as const;

/**
 * The store's row as the apply itself commits it when it starts an update (alchemy/src/Apply.ts):
 * the evaluated props, that plan's own binding rows with every value that was not known yet
 * stripped, and the row before it under `old`. An apply that stops at the upload leaves this.
 */
const committedUpdating = async (
  t: TestContext,
  given: {
    /** State before the interrupted apply. */
    finished: StateRows;
    /** State that apply planned against; by default `finished`. */
    plannedFrom?: StateRows;
    declared: Declared;
    /** What that apply's other resources had recorded by the time the store committed. */
    after?: (rows: StateRows) => StateRows;
    /** The store's evaluated `env` entries in that apply. */
    env?: (rows: StateRows) => Record<string, unknown>;
  },
): Promise<StateRows> => {
  const { plan } = await makePlan(t, {
    rows: given.plannedFrom ?? given.finished,
    declared: given.declared,
  });
  const node = plan.resources.ArtifactsCredentials as unknown as Planned["node"];
  assert.equal(node.action, "update");
  const after = given.after ? given.after(given.finished) : given.finished;
  const props = store(given.finished).props;
  return {
    ...after,
    ArtifactsCredentials: {
      ...store(given.finished),
      status: "updating",
      props: { ...props, env: { ...props.env, ...given.env?.(after) } },
      bindings: stripUnresolved(
        node.bindings
          .filter((binding) => binding.action !== "delete")
          .map(({ sid, data }) => ({ sid, data })),
      ),
      old: given.finished.ArtifactsCredentials,
    } as unknown as ResourceState,
  };
};
/** The vault bucket as an apply that changed its storage class recorded it. */
const bucketApplied = (rows: StateRows): StateRows => {
  const applied = rows.VaultAttachments as unknown as { props: object; attr: object };
  return {
    ...rows,
    VaultAttachments: {
      ...applied,
      props: { ...applied.props, storageClass: "InfrequentAccess" },
      attr: { ...applied.attr, storageClass: "InfrequentAccess" },
    } as unknown as ResourceState,
  };
};
/** State holds a second copy of one binding row after the first; the planner reads the last. */
const secondCopy =
  (
    sid: string,
    change: (wire: Record<string, unknown>, rows: StateRows) => Record<string, unknown>,
  ) =>
  (rows: StateRows) =>
    withStore(rows, ({ bindings }) => {
      const first = bindings.find((binding) => binding.sid === sid)!;
      return {
        bindings: [
          ...bindings,
          {
            sid,
            data: {
              ...first.data,
              bindings: first.data.bindings.map((wire) => change(wire, rows)),
            },
          },
        ],
      };
    });
const droppedKind = { type: "r2_s3_credentials", name: "POOL_AUTH_DATABASE", bucketName: "x" };

interface AllowanceCase {
  /** The design, or the review that tried it against an earlier form of the rule. */
  readonly from: "design" | "review 1" | "review 2" | "review 3" | "review 4";
  readonly name: string;
  /** Workers whose code moved since the last apply; by default the store and the two it can call. */
  readonly moved?: readonly string[];
  /** What the last apply declared for the store, where that is not the plain declaration. */
  readonly applied?: Credentials;
  /** State as it is now, made from the rows that apply recorded. `settle` runs another apply. */
  readonly state?: (
    rows: StateRows,
    settle: (declared: Declared) => Promise<StateRows>,
    t: TestContext,
  ) => StateRows | Promise<StateRows>;
  /** What the stack declares for the store now, on top of `applied`; `"nothing"` for no settings. */
  readonly declares?: Credentials | "nothing";
  /** What else the stack declares now. */
  readonly stack?: Declared;
  /** What the real planner made of it. */
  readonly planner?: (planned: Planned) => void;
  /** A change made to the plan by hand: a shape no declaration of this fixture produces. */
  readonly byHand?: (planned: Planned) => void;
  readonly codeOnly?: Record<string, unknown>;
  /** Other rows the policy admits. */
  readonly allow?: readonly object[];
  /** Admitted, or refused with each of these lines. */
  readonly expect:
    | "admitted"
    | {
        readonly lines: readonly RegExp[];
        /** Other rules that refuse it too. */
        readonly rules?: readonly string[];
        /** The allowance is the only rule that refuses it. */
        readonly alone?: true;
        /** Text the refusal must not print. */
        readonly without?: readonly string[];
      };
}
const refusedWith = (...lines: RegExp[]) => ({ lines });

const allowanceCases: readonly AllowanceCase[] = [
  // The store's code moves, and nothing else of it.
  {
    from: "design",
    name: "admits the store's code while the Worker it calls updates",
    planner: (planned) => {
      waits(planned, "TOOLS_SERVICE", "Api");
      assert.deepEqual(changedRows(planned), []);
    },
    expect: "admitted",
  },
  {
    from: "design",
    name: "refuses that entry when the policy does not name it",
    codeOnly: { references: [] },
    expect: refusedWith(TOOLS),
  },
  {
    from: "design",
    name: "refuses that entry when the policy names it for another resource",
    codeOnly: { references: [{ name: "TOOLS_SERVICE", resource: "Catalog" }] },
    expect: refusedWith(TOOLS),
  },
  {
    from: "design",
    name: "admits the store's code when nothing else moves",
    moved: onlyStore,
    planner: (planned) => known(planned, "TOOLS_SERVICE", "Api"),
    expect: "admitted",
  },
  // A named value.
  {
    from: "design",
    name: "admits a named value whose named field moves with the release, and its binding row",
    declares: { version: "2" },
    planner: (planned) => assert.deepEqual(changedRows(planned), ["EXECUTOR_TELEMETRY"]),
    expect: "admitted",
  },
  {
    from: "design",
    name: "refuses that value when the policy does not name it",
    declares: { version: "2" },
    codeOnly: { values: [] },
    expect: refusedWith(TELEMETRY_ROW, TELEMETRY),
  },
  {
    from: "review 1",
    name: "refuses a credential that changes beside the named field",
    declares: { token: "token-b" },
    expect: refusedWith(TELEMETRY_ROW, TELEMETRY),
  },
  {
    from: "review 1",
    name: "refuses the named field and the credential changing together",
    declares: { version: "2", token: "token-b" },
    expect: refusedWith(TELEMETRY_ROW, TELEMETRY),
  },
  {
    from: "review 1",
    name: "refuses a field the policy does not name, though it names another",
    declares: { version: "2" },
    codeOnly: {
      values: [{ name: "EXECUTOR_TELEMETRY", fields: ["environment"], why: "another field" }],
    },
    expect: refusedWith(TELEMETRY_ROW, TELEMETRY),
  },
  {
    from: "review 1",
    name: "refuses the same value as another kind of binding",
    declares: { version: "2", telemetryPlain: true },
    expect: refusedWith(TELEMETRY_ROW),
  },
  {
    from: "review 1",
    name: "refuses a named value that State does not hold",
    state: withoutEntry("EXECUTOR_TELEMETRY"),
    expect: refusedWith(
      /bindings\.EXECUTOR_TELEMETRY: create/u,
      /props\.env\.EXECUTOR_TELEMETRY: absent -> <redacted>/u,
    ),
  },
  {
    from: "review 1",
    name: "refuses a secret that is no record, though the policy names it as a value",
    declares: { secret: "another-secret" },
    codeOnly: {
      values: [...named("EXECUTOR_TELEMETRY"), ...named("POOL_APP_SIGNING_KEY")],
    },
    expect: refusedWith(SECRET),
  },
  // The entry file.
  ...[
    "/runner/_temp/candidate/scripts/release/test/plan-worker.ts",
    "file:///runner/_temp/candidate/scripts/release/test/plan-worker.ts",
  ].map((main): AllowanceCase => ({
    from: "design",
    name: `admits the same entry file recorded under another checkout (${main.startsWith("file:") ? "a file URL" : "a path"})`,
    state: recordedMain(main),
    planner: (planned) => assert.notEqual(planned.node.props.main, main),
    expect: "admitted",
  })),
  ...[
    ["another file", "/runner/_temp/candidate/scripts/release/test/another-worker.ts"],
    ["no directory boundary", "/runner/_temp/candidatescripts/release/test/plan-worker.ts"],
    ["another directory", "/runner/_temp/candidate/scripts/other/test/plan-worker.ts"],
    ["the file name alone", "/runner/_temp/candidate/plan-worker.ts"],
  ].map(([what, main]): AllowanceCase => ({
    from: "design",
    name: `refuses another entry file, wherever the checkout sits (${what})`,
    state: recordedMain(main!),
    expect: { lines: [/props\.main: /u], without: ["/runner/_temp"] },
  })),
  {
    from: "design",
    name: "refuses a declaration that names another file of this checkout",
    declares: { main: fileURLToPath(new URL("./test/plan-fixture.ts", import.meta.url)) },
    expect: refusedWith(/props\.main: /u),
  },
  // What a code-only release must never carry.
  {
    from: "design",
    name: "refuses a changed secret, and a reference that is not known yet does not hide it",
    declares: { secret: "another-signing-secret" },
    planner: (planned) => waits(planned, "TOOLS_SERVICE", "Api"),
    expect: {
      lines: [/bindings\.POOL_APP_SIGNING_KEY: update/u, SECRET],
      without: ["props: ", "TOOLS_SERVICE"],
    },
  },
  {
    from: "design",
    name: "refuses a changed secret, though the policy names it as a reference",
    declares: { secret: "another-signing-secret" },
    codeOnly: {
      references: [...toolsOnly.references, { name: "POOL_APP_SIGNING_KEY", resource: "Api" }],
    },
    expect: refusedWith(SECRET),
  },
  {
    from: "design",
    name: "refuses a changed value that the policy does not name",
    declares: { mode: "b" },
    expect: refusedWith(/bindings\.POOL_MODE: update/u, /props\.env\.POOL_MODE\.mode: /u),
  },
  {
    from: "design",
    name: "refuses a new class binding",
    stack: { credentialsClass: "SecondCoordinator" },
    expect: {
      lines: [/bindings\.Second: create/u],
      rules: ["code-only-binding-change ArtifactsCredentials"],
    },
  },
  {
    from: "design",
    name: "refuses a new entry",
    stack: { credentialsEnv: { MODE: "next" } },
    expect: refusedWith(/bindings\.MODE: create/u, /props\.env\.MODE: absent -> /u),
  },
  {
    from: "design",
    name: "refuses a removed binding",
    declares: "nothing",
    expect: {
      lines: [
        /bindings\.TOOLS_SERVICE: delete/u,
        /props\.env\.TOOLS_SERVICE\.workerName: .* -> absent/u,
      ],
      rules: ["worker-binding-removed ArtifactsCredentials"],
    },
  },
  {
    from: "design",
    name: "refuses a changed class",
    declares: { className: "ArtifactsTokenCoordinatorNext" },
    expect: {
      lines: [/bindings\.Coordinator: update/u],
      rules: ["durable-object-class-changed ArtifactsCredentials"],
    },
  },
  ...[storeWorkers, onlyStore].map((moved): AllowanceCase => ({
    from: "design",
    name: `refuses a declaration that calls another Worker under the same name (${moved.length > 1 ? "the tools Worker updating" : "nothing else moving"})`,
    moved,
    declares: { calls: "Catalog" },
    expect: refusedWith(TOOLS_ROW, TOOLS),
  })),
  // The policy itself.
  {
    from: "design",
    name: "refuses a policy that names one entry as a reference and as a value",
    codeOnly: { values: [...named("EXECUTOR_TELEMETRY"), ...named("TOOLS_SERVICE")] },
    expect: refusedWith(/policy\.TOOLS_SERVICE: named as a reference and as a value/u),
  },
  {
    from: "design",
    name: "refuses a policy whose reference names the Worker itself",
    codeOnly: {
      references: [...toolsOnly.references, { name: "VAULT", resource: "ArtifactsCredentials" }],
    },
    expect: refusedWith(/policy\.VAULT: names the Worker itself/u),
  },
  {
    from: "review 2",
    name: "refuses a policy that names one reference twice",
    codeOnly: {
      references: [...toolsOnly.references, { name: "TOOLS_SERVICE", resource: "Catalog" }],
    },
    expect: refusedWith(/policy\.TOOLS_SERVICE: named twice/u),
  },
  {
    from: "review 2",
    name: "refuses a policy that names one value twice",
    codeOnly: { values: [...named("EXECUTOR_TELEMETRY"), ...named("EXECUTOR_TELEMETRY")] },
    expect: refusedWith(/policy\.EXECUTOR_TELEMETRY: named twice/u),
  },
  // A reference to a Worker.
  {
    from: "review 1",
    name: "refuses another Worker in State under the entry and its row, while the named one updates",
    state: callsCatalog,
    planner: (planned) => waits(planned, "TOOLS_SERVICE", "Api"),
    expect: refusedWith(TOOLS, TOOLS_ROW),
  },
  {
    from: "review 2",
    name: "admits an older copy of the called Worker in State, also of what an update cannot change",
    // That Worker was replaced, and gained a class, in releases that left the store alone. The
    // store still binds it by name, so its binding row is unchanged.
    state: entry("TOOLS_SERVICE", (value) => ({
      ...value,
      workerId: "an-older-worker-id",
      durableObjectNamespaces: { Older: "0".repeat(32) },
    })),
    planner: (planned) => {
      waits(planned, "TOOLS_SERVICE", "Api");
      assert.deepEqual(changedRows(planned), []);
    },
    expect: "admitted",
  },
  {
    from: "review 2",
    name: "admits an older address of the called Worker in State when nothing else moves",
    moved: onlyStore,
    state: entry("TOOLS_SERVICE", (value) => ({ ...value, url: "https://older.invalid" })),
    planner: (planned) => known(planned, "TOOLS_SERVICE", "Api"),
    expect: "admitted",
  },
  {
    from: "review 2",
    name: "refuses that older address when the policy does not name the entry",
    moved: onlyStore,
    state: entry("TOOLS_SERVICE", (value) => ({ ...value, url: "https://older.invalid" })),
    codeOnly: { references: [] },
    expect: refusedWith(/TOOLS_SERVICE\.url/u),
  },
  {
    from: "review 3",
    name: "refuses a named resource that is replaced, not updated",
    byHand: (planned) => {
      (planned.plan.resources.Api as unknown as { action: string }).action = "replace";
    },
    expect: refusedWith(TOOLS),
  },
  // A reference to the database connection, while the connection updates.
  {
    from: "review 2",
    name: "admits the database connection's entry and row while the connection updates",
    declares: connectionMoves,
    allow: database,
    planner: (planned) => {
      databaseWaits(planned);
      assert.deepEqual(changedRows(planned), ["POOL_AUTH_DATABASE"]);
    },
    expect: "admitted",
  },
  {
    from: "review 2",
    name: "admits them when State's row has no local-development copy of the origin",
    state: row("POOL_AUTH_DATABASE", withoutLocalCopy),
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    expect: "admitted",
  },
  {
    from: "review 2",
    name: "refuses them when the policy does not name the entry",
    declares: connectionMoves,
    allow: database,
    codeOnly: toolsOnly,
    expect: { lines: [DATABASE_ROW, DATABASE], alone: true },
  },
  {
    from: "review 2",
    name: "refuses them when the policy names the entry for another resource",
    declares: connectionMoves,
    allow: database,
    codeOnly: {
      references: [...toolsOnly.references, { name: "POOL_AUTH_DATABASE", resource: "Api" }],
    },
    expect: { lines: [DATABASE_ROW, DATABASE], alone: true },
  },
  {
    from: "review 2",
    name: "refuses another connection in State under the entry and its row",
    state: each(otherConnectionEntry, otherConnectionRow),
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    expect: { lines: [DATABASE_ROW, DATABASE], alone: true },
  },
  {
    from: "review 2",
    name: "refuses another connection in State's row alone",
    state: otherConnectionRow,
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    expect: { lines: [DATABASE_ROW, DATABASE], alone: true },
  },
  ...(
    [
      ["a second wire entry", secondWireEntry],
      ["a key the plan does not carry", (data: RowData) => ({ ...data, extra: true })],
      ["no wire entry", (data: RowData) => ({ ...data, bindings: [] })],
      ["a wire entry without the connection's id", wireEntry(({ id: _none, ...wire }) => wire)],
    ] as const
  ).map(([what, change]): AllowanceCase => ({
    from: "review 2",
    name: `refuses a waiting row when State's row holds ${what}`,
    state: row("POOL_AUTH_DATABASE", change),
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    expect: refusedWith(DATABASE_ROW),
  })),
  ...(
    [
      [
        "a second wire entry",
        ({ data }: StoreRow) => ({
          ...data,
          bindings: [...data.bindings, { type: "plain_text", name: "MODE", text: "next" }],
        }),
      ],
      [
        // The upload would carry whatever it turns out to be.
        "a wire entry that is not known yet",
        ({ data }: StoreRow) => ({
          ...data,
          bindings: data.bindings.map((wire) => ({ ...wire, id: data.hyperdrives })),
        }),
      ],
      [
        "nothing known: the row as a whole waits on the connection",
        ({ data }: StoreRow) => data.hyperdrives,
      ],
      [
        "an unknown under another key than the local-development copy",
        ({ data }: StoreRow) => ({ ...data, devRemote: data.hyperdrives }),
      ],
      [
        // A comparison of plain values does not see it: it has to be asked for.
        "a key State lacks whose value is an unfinished computation",
        ({ data }: StoreRow) => ({ ...data, extra: Effect.succeed("later") }),
      ],
    ] as const
  ).map(([what, change]): AllowanceCase => ({
    from: what.startsWith("a key State lacks") ? "review 3" : "review 2",
    name: `refuses a waiting row when the plan's row holds ${what}`,
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    byHand: (planned) => {
      const waiting = planned.row("POOL_AUTH_DATABASE");
      waiting.data = change(waiting) as RowData;
    },
    expect: { lines: [DATABASE_ROW, DATABASE], alone: true },
  })),
  {
    from: "review 2",
    name: "refuses a waiting row whose local-development copy waits on another resource",
    declares: connectionMoves,
    allow: database,
    planner: (planned) => {
      databaseWaits(planned);
      waits(planned, "TOOLS_SERVICE", "Api");
    },
    byHand: (planned) => {
      const waiting = planned.row("POOL_AUTH_DATABASE");
      waiting.data = { ...waiting.data, hyperdrives: planned.node.props.env.TOOLS_SERVICE };
    },
    expect: { lines: [DATABASE_ROW, DATABASE], alone: true },
  },
  {
    from: "review 2",
    name: "refuses an entry that is a value derived from the resource, not the resource",
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    byHand: (planned) => {
      planned.node.props.env.POOL_AUTH_DATABASE =
        planned.row("POOL_AUTH_DATABASE").data.hyperdrives;
    },
    expect: { lines: [DATABASE], alone: true },
  },
  {
    from: "review 2",
    name: "refuses an entry that has no binding row of its own",
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    byHand: (planned) => {
      planned.node.bindings = planned.node.bindings.filter(
        (binding) => binding.sid !== "POOL_AUTH_DATABASE",
      );
    },
    expect: refusedWith(DATABASE),
  },
  // A reference to a bucket: its wire entry is not known while the bucket updates.
  ...(
    [
      ["as State holds it", (rows: StateRows) => rows],
      [
        "State holding it in another jurisdiction",
        row(
          "VAULT",
          wireEntry((wire) => ({ ...wire, jurisdiction: "eu" })),
        ),
      ],
      [
        "State holding another bucket",
        each(
          entry("VAULT", (value) => ({ ...value, bucketName: otherBucket })),
          row(
            "VAULT",
            wireEntry((wire) => ({ ...wire, bucketName: otherBucket })),
          ),
        ),
      ],
    ] as const
  ).map(([what, state]): AllowanceCase => ({
    from: "review 2",
    name: `refuses a named bucket's entry and row while that bucket updates (${what})`,
    state,
    stack: bucketMoves,
    allow: bucket,
    planner: bucketWaits,
    expect: { lines: [/bindings\.VAULT: update/u, /props\.env\.VAULT: /u], alone: true },
  })),
  // The connection is unchanged; State holds local development's copy of its origin in another form.
  ...localCopyForms.map(([what, change]): AllowanceCase => ({
    from: "review 3",
    name: `admits the connection's row when it differs only in State holding ${what} local-development copy`,
    moved: onlyStore,
    state: row("POOL_AUTH_DATABASE", change),
    planner: databaseRowDiffers,
    expect: "admitted",
  })),
  // The healing plan itself, with production's settings: the store's code moves in one plan with
  // the tools Worker and the pool Worker, and the connection is unchanged.
  {
    from: "design",
    name: "admits the healing plan: the store's code with the tools Worker and the pool Worker updating",
    moved: healingPlan,
    planner: (planned) => {
      healing(planned);
      assert.deepEqual(changedRows(planned), []);
    },
    expect: "admitted",
  },
  ...localCopyForms.map(([what, change]): AllowanceCase => ({
    from: "design",
    name: `admits the healing plan when State's row for the connection holds ${what} local-development copy`,
    moved: healingPlan,
    state: row("POOL_AUTH_DATABASE", change),
    planner: (planned) => {
      healing(planned);
      databaseRowDiffers(planned);
      assert.deepEqual(changedRows(planned), ["POOL_AUTH_DATABASE"]);
    },
    expect: "admitted",
  })),
  {
    from: "review 3",
    name: "refuses that row when the policy does not name the entry",
    moved: onlyStore,
    state: row("POOL_AUTH_DATABASE", withoutLocalCopy),
    codeOnly: toolsOnly,
    planner: databaseRowDiffers,
    expect: refusedWith(DATABASE_ROW),
  },
  ...(
    [
      ["another connection", wireEntry((wire) => ({ ...wire, id: otherConnection }))],
      ["a second wire entry", secondWireEntry],
      ["a key the plan does not carry", (data: RowData) => ({ ...data, extra: true })],
    ] as const
  ).map(([what, change]): AllowanceCase => ({
    from: "review 3",
    name: `refuses that row when State's also holds ${what}`,
    moved: onlyStore,
    state: row("POOL_AUTH_DATABASE", (data, rows) =>
      change(withoutLocalCopy(data) as RowData, rows),
    ),
    planner: databaseRowDiffers,
    expect: refusedWith(DATABASE_ROW),
  })),
  {
    from: "review 3",
    name: "refuses a row that holds no wire entry in State and in the plan",
    moved: onlyStore,
    state: row("POOL_AUTH_DATABASE", (data) => ({ ...data, bindings: [], hyperdrives: {} })),
    planner: databaseRowDiffers,
    byHand: (planned) => {
      const differing = planned.row("POOL_AUTH_DATABASE");
      differing.data = { ...differing.data, bindings: [] };
    },
    expect: refusedWith(DATABASE_ROW),
  },
  // Stack code binds its own row under the entry's name, with a wire entry of another name. With
  // no wire entry of its name, the provider uploads the entry's own value: the connection's
  // attributes, as they are after it applied.
  {
    from: "review 3",
    name: "refuses a reference whose row carries a wire entry of another name, while the connection updates",
    applied: { ownDatabaseRow: true },
    declares: connectionMoves,
    allow: database,
    planner: (planned) => {
      waits(planned, "POOL_AUTH_DATABASE", "PoolModelDatabaseConnection");
      assert.deepEqual(
        planned.row("POOL_AUTH_DATABASE").data.bindings.map((wire) => wire.name),
        ["MODEL_DB"],
      );
    },
    expect: refusedWith(DATABASE),
  },
  {
    from: "review 3",
    name: "refuses that reference when an earlier release moved the connection and only its local copy differs",
    applied: { ownDatabaseRow: "with local copy" },
    moved: onlyStore,
    state: connectionMovedEarlier,
    declares: connectionMoves,
    planner: (planned) => {
      databaseRowDiffers(planned);
      assert.deepEqual(
        planned.row("POOL_AUTH_DATABASE").data.bindings.map((wire) => wire.name),
        ["MODEL_DB"],
      );
    },
    expect: refusedWith(DATABASE_ROW, DATABASE),
  },
  // An interrupted apply: the planner compares the plan with the unfinished generation only.
  {
    from: "review 3",
    name: "refuses another Worker in the last finished generation, though the planner calls the row unchanged",
    state: (rows) => storeInterrupted(rows, callsCatalog(rows)),
    planner: (planned) => {
      waits(planned, "TOOLS_SERVICE", "Api");
      unchangedForThePlanner("TOOLS_SERVICE")(planned);
    },
    expect: refusedWith(TOOLS, TOOLS_ROW),
  },
  {
    from: "review 3",
    name: "refuses the same when the called Worker itself is unchanged",
    moved: onlyStore,
    state: (rows) => storeInterrupted(rows, callsCatalog(rows)),
    planner: (planned) => {
      known(planned, "TOOLS_SERVICE", "Api");
      unchangedForThePlanner("TOOLS_SERVICE")(planned);
    },
    expect: refusedWith(TOOLS, TOOLS_ROW),
  },
  {
    from: "review 3",
    name: "refuses another connection in the last finished generation while the connection updates",
    state: (rows) => storeInterrupted(rows, each(otherConnectionEntry, otherConnectionRow)(rows)),
    declares: connectionMoves,
    allow: database,
    planner: databaseWaits,
    expect: refusedWith(DATABASE, DATABASE_ROW),
  },
  {
    from: "design",
    name: "admits the store's code after an interrupted apply that changed nothing else",
    state: (rows) => storeInterrupted(rows, rows),
    planner: (planned) => assert.equal(planned.node.action, "update"),
    expect: "admitted",
  },
  {
    from: "design",
    name: "admits an interrupted code-only apply run again: the named field differs in the finished generation only",
    state: async (rows, settle) =>
      storeInterrupted(await settle({ credentials: { version: "2" } }), rows),
    declares: { version: "2" },
    planner: unchangedForThePlanner("EXECUTOR_TELEMETRY"),
    expect: "admitted",
  },
  {
    from: "design",
    name: "admits it when the named field moved on once more",
    state: async (rows, settle) =>
      storeInterrupted(await settle({ credentials: { version: "2" } }), rows),
    declares: { version: "3" },
    planner: (planned) => assert.deepEqual(changedRows(planned), ["EXECUTOR_TELEMETRY"]),
    expect: "admitted",
  },
  {
    from: "design",
    name: "refuses a secret the interrupted apply changed, when the declaration is the finished generation's again",
    // The interrupted upload may have gone out: taking the change back is a change too.
    state: async (rows, settle) =>
      storeInterrupted(await settle({ credentials: { secret: "the-interrupted-secret" } }), rows),
    planner: (planned) => assert.deepEqual(changedRows(planned), ["POOL_APP_SIGNING_KEY"]),
    expect: refusedWith(/bindings\.POOL_APP_SIGNING_KEY: update/u, SECRET),
  },
  {
    from: "design",
    name: "refuses a secret the interrupted apply changed, when the declaration keeps it",
    state: async (rows, settle) =>
      storeInterrupted(await settle({ credentials: { secret: "the-interrupted-secret" } }), rows),
    declares: { secret: "the-interrupted-secret" },
    planner: unchangedForThePlanner("POOL_APP_SIGNING_KEY"),
    expect: refusedWith(SECRET, /bindings\.POOL_APP_SIGNING_KEY: update/u),
  },
  {
    from: "design",
    name: "refuses an entry of the last finished generation that the interrupted apply dropped",
    state: async (rows, settle) =>
      storeInterrupted(rows, await settle({ credentials: {}, credentialsEnv: { MODE: "before" } })),
    planner: (planned) =>
      assert.ok(!planned.node.bindings.some((binding) => binding.sid === "MODE")),
    expect: refusedWith(/bindings\.MODE: delete/u, /props\.env\.MODE: /u),
  },
  // An interrupted apply, with State written the way the apply itself commits it.
  {
    from: "review 4",
    name: "admits the healing plan run again after it stopped at the store, State as the apply commits it",
    moved: healingPlan,
    state: (rows, _settle, t) =>
      committedUpdating(t, {
        finished: rows,
        declared: { credentials: {} },
        env: (after) => ({ TOOLS_SERVICE: { ...attributes(after, "Api") } }),
      }),
    planner: healing,
    expect: "admitted",
  },
  {
    from: "review 4",
    name: "admits the healing plan run again when the tools Worker had finished, State as the apply commits it",
    moved: ["ArtifactsCredentials", "PoolWorker"],
    state: (rows, _settle, t) =>
      committedUpdating(t, {
        finished: rows,
        plannedFrom: withCodeFromElsewhere(rows, healingPlan),
        declared: { credentials: {} },
      }),
    planner: (planned) => known(planned, "TOOLS_SERVICE", "Api"),
    expect: "admitted",
  },
  {
    from: "review 4",
    name: "admits the store's code after a release that moved the database connection stopped at the store",
    moved: onlyStore,
    state: (rows, _settle, t) =>
      committedUpdating(t, {
        finished: rows,
        declared: { credentials: connectionMoves },
        after: connectionMovedEarlier,
        env: (after) => ({
          POOL_AUTH_DATABASE: { ...attributes(after, "PoolModelDatabaseConnection") },
        }),
      }),
    declares: connectionMoves,
    planner: (planned) => known(planned, "POOL_AUTH_DATABASE", "PoolModelDatabaseConnection"),
    expect: "admitted",
  },
  {
    from: "review 4",
    name: "refuses the store's code after a release that was updating the vault bucket stopped at the store",
    // A refusal that is not a real change, kept on purpose. The bucket's jurisdiction was not known
    // in the interrupted plan, so the unfinished generation's row lost it, and the plan now differs
    // from that row. Admitting a row because State lost a value would be a guess; the way out is
    // to finish the interrupted release.
    moved: onlyStore,
    state: (rows, _settle, t) =>
      committedUpdating(t, {
        finished: rows,
        declared: { credentials: {}, ...bucketMoves },
        after: bucketApplied,
        env: (after) => ({ VAULT: { ...attributes(after, "VaultAttachments") } }),
      }),
    stack: bucketMoves,
    planner: (planned) => {
      assert.equal(planned.plan.resources.VaultAttachments?.action, "noop");
      assert.equal(planned.row("VAULT").action, "update");
      assert.ok(isResolved(planned.row("VAULT").data));
    },
    expect: refusedWith(/bindings\.VAULT: update/u),
  },
  {
    from: "review 4",
    name: "refuses the named Worker when the unfinished generation bound another one",
    state: (rows) => storeInterrupted(callsCatalog(rows), rows),
    planner: (planned) => {
      waits(planned, "TOOLS_SERVICE", "Api");
      assert.equal(planned.row("TOOLS_SERVICE").action, "update");
    },
    expect: refusedWith(TOOLS_ROW),
  },
  {
    from: "review 4",
    name: "refuses taking back a credential an interrupted apply changed in the named value",
    state: async (rows, settle) =>
      storeInterrupted(await settle({ credentials: { token: "token-b" } }), rows),
    declares: { version: "2" },
    planner: (planned) => assert.equal(planned.row("EXECUTOR_TELEMETRY").action, "update"),
    expect: refusedWith(TELEMETRY_ROW, TELEMETRY),
  },
  // Production's cycle: the tools Worker binds the store's class, and the store refers to it.
  {
    from: "review 4",
    name: "admits the healing plan when the tools Worker binds the store's class, as production's does",
    moved: healingPlan,
    applied: { calledBindsStore: true },
    planner: healing,
    expect: "admitted",
  },
  {
    from: "review 4",
    name: "admits that plan run again after it stopped at the store, State as the apply commits it",
    moved: healingPlan,
    applied: { calledBindsStore: true },
    state: (rows, _settle, t) =>
      committedUpdating(t, {
        finished: rows,
        declared: { credentials: { calledBindsStore: true } },
      }),
    planner: (planned) => assert.equal(planned.node.action, "update"),
    expect: "admitted",
  },
  // Shapes this version of the library never writes. The rule does not lean on that.
  {
    from: "review 4",
    name: "refuses a tools row State holds twice, when the copy the planner reads binds another Worker",
    state: each(
      entry("TOOLS_SERVICE", (_value, rows) => ({ ...attributes(rows, "Catalog") })),
      secondCopy("TOOLS_SERVICE", (wire, rows) => ({
        ...wire,
        service: attributes(rows, "Catalog").workerName,
      })),
    ),
    planner: (planned) => {
      waits(planned, "TOOLS_SERVICE", "Api");
      assert.equal(planned.row("TOOLS_SERVICE").action, "update");
    },
    expect: refusedWith(TOOLS_ROW),
  },
  {
    from: "review 4",
    name: "refuses a value row State holds twice, when the copy the planner reads has another credential",
    state: secondCopy("EXECUTOR_TELEMETRY", (wire) => ({
      ...wire,
      text: JSON.stringify({ version: "1", traces: { headers: { authorization: "token-b" } } }),
    })),
    declares: { version: "2" },
    planner: (planned) => assert.equal(planned.row("EXECUTOR_TELEMETRY").action, "update"),
    expect: refusedWith(TELEMETRY_ROW),
  },
  {
    from: "review 4",
    name: "refuses State whose generation under an interrupted apply is itself unfinished",
    // A secret that differs only in the generation below that one would otherwise never be compared.
    state: async (rows, settle) => {
      const older = await settle({ credentials: { secret: "the-older-secret" } });
      return withStore(rows, (unfinished) => ({
        status: "updating",
        old: { ...unfinished, status: "updating", old: older.ArtifactsCredentials },
      }));
    },
    expect: refusedWith(/state: the generation under the interrupted apply is not a finished one/u),
  },
  {
    from: "review 4",
    name: "refuses a reference row named by a wire entry of a kind the upload drops",
    // Only local development emits that kind. The live upload drops it, and with no wire entry of
    // the entry's name left, the provider uploads the entry's own value.
    state: row("POOL_AUTH_DATABASE", (data) => ({ ...data, bindings: [droppedKind] })),
    declares: connectionMoves,
    allow: database,
    planner: (planned) => waits(planned, "POOL_AUTH_DATABASE", "PoolModelDatabaseConnection"),
    byHand: (planned) => {
      const waiting = planned.row("POOL_AUTH_DATABASE");
      waiting.data = { ...waiting.data, bindings: [droppedKind] };
    },
    expect: refusedWith(DATABASE),
  },
];

test("the code-only allowance, case by case", async (context) => {
  const names = allowanceCases.map(({ from, name }) => `${from}: ${name}`);
  assert.equal(new Set(names).size, names.length, "two cases share a name");
  for (const [index, given] of allowanceCases.entries())
    await context.test(names[index]!, async (t) => {
      const settle = async (declared: Declared) =>
        withCodeFromElsewhere(
          (
            await makePlan(t, {
              rows: { ...productionRows(), ...calledRows() },
              declared,
              settle: storeWorkers,
            })
          ).rows,
          given.moved ?? storeWorkers,
        );
      const applied = await settle({ credentials: given.applied ?? {} });
      const rows = given.state ? await given.state(applied, settle, t) : applied;
      const { plan } = await makePlan(t, {
        rows,
        declared: {
          ...(given.declares === "nothing"
            ? {}
            : { credentials: { ...given.applied, ...given.declares } }),
          ...given.stack,
        },
      });
      const node = plan.resources.ArtifactsCredentials as unknown as Planned["node"];
      const planned: Planned = {
        plan,
        node,
        row: (sid) => {
          const found = node.bindings.find((binding) => binding.sid === sid);
          assert.ok(found, `no binding row ${sid}`);
          return found;
        },
      };
      given.planner?.(planned);
      given.byHand?.(planned);
      const changes = allowance(given.codeOnly, given.allow);
      if (given.expect === "admitted") {
        const exit = await Effect.runPromiseExit(checkPlan(plan, await policy(changes)));
        if (Exit.isFailure(exit)) assert.fail(String((Cause.squash(exit.cause) as Error).message));
        assert.ok(exit.value.some((change) => change.fqn === "ArtifactsCredentials"));
        return;
      }
      const { rules, message } = await refused(plan, changes);
      const own = "code-only-allowance-exceeded ArtifactsCredentials";
      assert.ok(rules.includes(own), `${rules.join(", ")}\n${message}`);
      for (const line of given.expect.lines) assert.match(message, line);
      for (const rule of given.expect.rules ?? [])
        assert.ok(rules.includes(rule), rules.join(", "));
      if (given.expect.alone) assert.deepEqual(rules, [own], message);
      for (const text of given.expect.without ?? []) assert.ok(!message.includes(text), message);
    });
});

test("a code-only allowance cannot be declared with an empty name, field list or reason", async () => {
  const value = (name: string, why = "a reason") => [{ name, fields: ["version"], why }];
  await assert.rejects(policy(allowance({ values: value("") })));
  await assert.rejects(policy(allowance({ values: value("EXECUTOR_TELEMETRY", " ") })));
  await assert.rejects(
    policy(allowance({ values: [{ name: "EXECUTOR_TELEMETRY", fields: [], why: "a reason" }] })),
  );
  await assert.rejects(policy(allowance({ why: "" })));
  await assert.rejects(policy(allowance({ references: [{ name: "", resource: "Api" }] })));
});

test("a filtered plan needs the policy's include list, and the list needs a filtered plan", async (context) => {
  const selected = await planned(context, { include: ["PoolWorker"] });
  assert.deepEqual((await refused(selected.plan)).rules, ["filtered-plan-without-include (plan)"]);
  assert.deepEqual((await refused(selected.plan, { include: ["PoolDatabase"] })).rules, [
    "include-not-selected PoolDatabase",
  ]);
  const full = await planned(context);
  assert.deepEqual((await refused(full.plan, { include: ["PoolWorker"] })).rules, [
    "full-plan-with-include (plan)",
  ]);
});

test("every violation of a plan is reported at once", async (context) => {
  const { plan } = await planned(context, {
    declared: { ledger: undefined, bucketJurisdiction: "default", databaseCommand: false },
    rows: { ...productionRows(), ScratchRecords: retainedScratchRow() },
  });
  assert.deepEqual((await refused(plan)).rules.sort(), [
    "durable-object-class-removed PoolWorker",
    "protected-resource-destroyed VaultAttachments",
    "unreviewed-removal ScratchRecords",
  ]);
});

test("the plan digest is stable for the same inputs and moves with the plan", async (context) => {
  const first = await planned(context);
  const second = await planned(context);
  assert.match(planDigest(first.plan), /^[a-f0-9]{64}$/u);
  assert.equal(planDigest(first.plan), planDigest(second.plan));
  const changed = await planned(context, { declared: { newClass: true } });
  assert.notEqual(planDigest(first.plan), planDigest(changed.plan));
});

test("a policy with an unknown key or an unpinned image is not decoded", async () => {
  await assert.rejects(policy({ removal: [] }));
  await assert.rejects(policy({ poolContainer: { fqn: "PoolContainer", image: "pool:latest" } }));
});

test("a Worker binding whose value waits on another row is not a removal", async () => {
  const { literal } = await import("alchemy/Output");
  const recorded = {
    bindings: [{ type: "plain_text", name: "EXECUTOR_SITE_BUILD", text: "built" }],
  };
  const node = (data: unknown) => ({
    action: "update",
    resource: { FQN: "Dashboard", Type: "Cloudflare.Worker", Props: {} },
    props: {},
    state: {
      status: "updated",
      props: {},
      bindings: [{ sid: "EXECUTOR_SITE_BUILD", data: recorded }],
    },
    bindings: [{ sid: "EXECUTOR_SITE_BUILD", action: "update", data }],
  });
  const plan = (data: unknown) =>
    ({
      resources: { Dashboard: node(data) },
      deletions: {},
      actions: {},
      actionDeletions: {},
    }) as never;
  // The site build's hash is not known until the build row resolves.
  const exit = await Effect.runPromiseExit(
    checkPlan(plan({ bindings: literal([]) }), await policy({ mode: "code-only" })),
  );
  const rules = Exit.isFailure(exit)
    ? (Cause.squash(exit.cause) as PlanRefused).violations.map((v) => v.rule)
    : [];
  assert.ok(!rules.includes("worker-binding-removed"), rules.join(", "));
  // Resolved to nothing, it is still the removal it always was.
  assert.ok(
    (await refused(plan({ bindings: [] }), { mode: "code-only" })).rules.includes(
      "worker-binding-removed Dashboard",
    ),
  );
});

const rootUnchanged = { poolContainer: { fqn: "PoolContainer", image: pinnedImage } };

test("with a root pin, the pool Worker names the pin's input as its root's identity, both ways", async () => {
  const input = "526fa60bed0df442";
  const worker = (env: Record<string, string>) => ({
    action: "update",
    resource: { FQN: "PoolWorker", Type: "Cloudflare.Worker", Props: { env } },
    props: { env },
    state: { status: "updated", props: { env }, bindings: [] },
    bindings: [],
  });
  const plan = (node: object) =>
    ({ resources: { PoolWorker: node }, deletions: {}, actions: {}, actionDeletions: {} }) as never;
  const rules = async (node: object, pinned: string | undefined) => {
    const exit = await Effect.runPromiseExit(
      checkPlan(
        plan(node),
        await policy({
          mode: "code-only",
          poolContainer: {
            fqn: "PoolContainer",
            image: pinnedImage,
            imageRelease: true,
            ...(pinned ? { input: pinned } : {}),
          },
        }),
      ),
    );
    return Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as PlanRefused).violations.map(
          (v) => `${v.rule} ${v.change.join("; ")}`,
        )
      : [];
  };
  const both = { POOL_IMAGE_HASH: input, POOL_DESIRED_IMAGE_INPUT: input };
  assert.deepEqual(await rules(worker(both), input), []);
  // Today's context hash as the desired input would stop the apply after the upload.
  assert.deepEqual(
    await rules(worker({ ...both, POOL_DESIRED_IMAGE_INPUT: "0123456789abcdef" }), input),
    [
      "pool-worker-image-input-not-pinned env.POOL_DESIRED_IMAGE_INPUT: differs from the root pin's input",
    ],
  );
  assert.deepEqual(await rules(worker({ POOL_DESIRED_IMAGE_INPUT: input }), input), [
    "pool-worker-image-input-not-pinned env.POOL_IMAGE_HASH: differs from the root pin's input",
  ]);
  // Without a pin the root builds from the context, and the rule has nothing to compare.
  assert.deepEqual(await rules(worker({}), undefined), []);
});

test("a release given no root pin, a tag, or another digest than the root runs is refused in plan", async (context) => {
  // Unset: the entry hands the check an empty image, which is no digest reference.
  await assert.rejects(policy({ poolContainer: { fqn: "PoolContainer", image: "" } }));
  // A tag names whatever the registry holds under it today.
  const tag = pinnedImage.replace(/@sha256:e{64}$/u, ":latest");
  await assert.rejects(policy({ poolContainer: { fqn: "PoolContainer", image: tag } }));
  // Another digest, set consistently: the declaration follows the pin, so the pin rule alone
  // cannot see it; the recorded image the root runs differs from it.
  const other = pinnedImage.replace(/e{64}$/u, "f".repeat(64));
  const wrong = await planned(context, { declared: { container: { image: other } } });
  const { rules, message } = await refused(wrong.plan, {
    poolContainer: { fqn: "PoolContainer", image: other },
  });
  assert.deepEqual(rules, [
    "pool-container-configuration-change PoolContainer",
    "pool-container-not-noop PoolContainer",
  ]);
  assert.match(message, /props\.image: /u);
  // The right pin has no configuration change: only the old layer's hash-only row remains.
  const right = await planned(context);
  assert.deepEqual((await refused(right.plan, rootUnchanged)).rules, [
    "pool-container-not-noop PoolContainer",
  ]);
  // The plan only read: nothing was sent that could roll the root.
  assert.ok(wrong.requests.every((request) => request.startsWith("GET ")));
});

test("no release but a declared image release may plan any row on the root, a hash-only update included", async (context) => {
  // Production's root row was written by the old release layer: its recorded image hash is the old
  // build context's, so an unchanged root plans a hash-only update.
  const { plan } = await planned(context);
  assert.equal(plan.resources.PoolContainer?.action, "update");
  for (const mode of ["release", "code-only"] as const) {
    const { rules, message } = await refused(plan, { ...rootUnchanged, mode });
    assert.ok(
      rules.includes("pool-container-not-noop PoolContainer"),
      `${mode}: ${rules.join(", ")}`,
    );
    assert.match(message, /\$action: noop -> update/u);
  }
  // An image release that declares it may move the row; a configuration change still refuses.
  assert.ok((await admitted(plan)).includes("update PoolContainer"));
});

test("a healing release admits a connection only while its origin waits on a database command", async () => {
  const { literal } = await import("alchemy/Output");
  const connection = (origin: unknown) => ({
    action: "update",
    resource: { FQN: "DatabaseConnection", Type: "Cloudflare.Hyperdrive", Props: { origin } },
    props: { origin },
    state: { status: "updated", props: { origin: "recorded-origin" }, bindings: [] },
    bindings: [],
  });
  const command = (fqn: string) => ({
    action: "update",
    resource: { FQN: fqn, Type: "Command.Exec", Props: {} },
    props: {},
    state: { status: "updated", props: {}, bindings: [] },
    bindings: [],
  });
  const plan = (...nodes: { resource: { FQN: string } }[]) =>
    ({
      resources: Object.fromEntries(nodes.map((node) => [node.resource.FQN, node])),
      deletions: {},
      actions: {},
      actionDeletions: {},
    }) as never;
  const healing = {
    mode: "code-only",
    commands: ["Migrations"],
    allow: [{ fqn: "DatabaseConnection", action: "update", unresolvedOnly: true }],
  };
  const rules = async (value: never) => {
    const exit = await Effect.runPromiseExit(checkPlan(value, await policy(healing)));
    return Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as PlanRefused).violations.map((v) => `${v.rule} ${v.fqn}`)
      : [];
  };
  // The origin is not known until the migration's hash resolves: the row the release expects.
  assert.deepEqual(await rules(plan(connection(literal("pending")), command("Migrations"))), []);
  // Another database is a resolved change, and a command outside the list does not run.
  assert.deepEqual(await rules(plan(connection("another-origin"))), [
    "outside-code-only DatabaseConnection",
  ]);
  assert.deepEqual(await rules(plan(command("Seed"))), ["outside-code-only Seed"]);
});

test("the healing release admits the root's row only as the recorded hash the old layer left", async () => {
  const { sha256Object } = await import("alchemy/Util/sha256");
  const { Effect: E } = await import("effect");
  const referenceHash = (
    await E.runPromise(sha256Object({ image: pinnedImage, imageName: undefined }))
  ).slice(0, 16);
  const settings = {
    image: pinnedImage,
    className: "PoolContainer",
    schedulingPolicy: "default",
    instanceType: "basic",
    maxInstances: 1,
  };
  const root = (
    change: {
      action?: string;
      props?: Record<string, unknown>;
      hash?: string | undefined;
      binding?: string;
    } = {},
  ) => {
    const props = { ...settings, ...change.props };
    return {
      action: change.action ?? "update",
      resource: { FQN: "PoolContainer", Type: "Cloudflare.Container", Props: props },
      props,
      state: {
        status: "updated",
        props: settings,
        attr: { hash: "hash" in change ? { image: change.hash } : { image: "a".repeat(16) } },
        bindings: [{ sid: "PoolContainer", data: { durableObjects: { namespaceId: "ns-root" } } }],
      },
      bindings: [
        {
          sid: "PoolContainer",
          action: change.binding ?? "noop",
          data: { durableObjects: { namespaceId: "ns-root" } },
        },
      ],
    };
  };
  const plan = (node: object) =>
    ({
      resources: { PoolContainer: node },
      deletions: {},
      actions: {},
      actionDeletions: {},
    }) as never;
  const rules = async (node: object, recordedHashOnly = true) => {
    const exit = await Effect.runPromiseExit(
      checkPlan(
        plan(node),
        await policy({
          mode: "code-only",
          poolContainer: {
            fqn: "PoolContainer",
            image: pinnedImage,
            ...(recordedHashOnly ? { recordedHashOnly: true } : {}),
          },
        }),
      ),
    );
    return Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as PlanRefused).violations.map((v) => `${v.rule} ${v.fqn}`)
      : [];
  };
  // Exactly the old layer's row: an update whose only difference is the recorded hash.
  assert.deepEqual(await rules(root()), []);
  assert.notEqual("a".repeat(16), referenceHash);
  const notNoop = "pool-container-not-noop PoolContainer";
  // Each other way the row can plan refuses.
  for (const [deviation, node] of [
    ["a changed setting", root({ props: { instanceType: "standard" } })],
    ["an attachment that changes", root({ binding: "update" })],
    [
      "another image declared",
      root({ props: { image: pinnedImage.replace(/e{64}$/u, "f".repeat(64)) } }),
    ],
    ["a recorded hash that already names the reference", root({ hash: referenceHash })],
    ["no recorded hash", root({ hash: undefined })],
    ["a replace", root({ action: "replace" })],
  ] as const) {
    // A replace never reaches the root's own rules: the protected-resource rule refuses it first.
    const refused = await rules(node);
    assert.ok(
      deviation === "a replace" ? refused.length > 0 : refused.includes(notNoop),
      deviation,
    );
  }
  // Any other policy refuses the row as it is.
  assert.deepEqual(await rules(root(), false), [notNoop]);
});

/** Production's pool Worker has long recorded the database command's outcome as a setting. */
const recordsReadiness = (rows: ReturnType<typeof productionRows>) => {
  (rows.PoolWorker as unknown as { bindings: { sid: string; data: unknown }[] }).bindings.push({
    sid: "POOL_DATABASE_READY",
    data: { bindings: [{ type: "plain_text", name: "POOL_DATABASE_READY", text: "ready" }] },
  });
  return rows;
};

test("the root's attachment that waits on the pool Worker settles only as lane 1's row, its namespace recorded on both rows", async (context) => {
  const root = { fqn: "PoolContainer", image: pinnedImage };
  const healing = {
    mode: "code-only",
    poolContainer: { ...root, recordedHashOnly: true, workerAttachment: true },
  };
  const rulesFor = async (plan: Plan.Plan, changes: Record<string, unknown> = healing) => {
    const exit = await Effect.runPromiseExit(checkPlan(plan, await policy(changes)));
    return Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as PlanRefused).violations.map((v) => `${v.rule} ${v.fqn}`)
      : [];
  };
  const notNoop = "pool-container-not-noop PoolContainer";
  type Mutable = { action: string; bindings: { sid: string; action: string; data: unknown }[] };
  const waits = (declared: Record<string, unknown> = {}, rows = productionRows()) =>
    planned(context, {
      rows: recordsReadiness(rows),
      declared: { poolWorkerWaitsOnCommand: true, ...declared },
    });

  // The real planner, the pool Worker reading the pool database command's outcome: lane 1's row.
  const lane = (await waits()).plan;
  const row = lane.resources.PoolContainer as unknown as Mutable & {
    resource: { Props: Record<string, unknown> };
    state: { props: Record<string, unknown> };
  };
  assert.equal(row.action, "update");
  assert.deepEqual(propChanges(row.state.props, row.resource.Props), []);
  assert.deepEqual(
    row.bindings
      .filter((binding) => binding.action !== "noop")
      .map(({ sid, action }) => ({ sid, action })),
    [{ sid: "PoolContainer", action: "update" }],
  );
  assert.equal(lane.resources.PoolWorker?.action, "update");
  assert.ok(!(await rulesFor(lane)).includes(notNoop), "the healing release admits it");
  // Without the policy's say, the same row refuses.
  assert.ok(
    (
      await rulesFor(lane, { ...healing, poolContainer: { ...root, recordedHashOnly: true } })
    ).includes(notNoop),
  );

  const refuses = async (deviation: string, plan: Plan.Plan) =>
    assert.ok((await rulesFor(plan)).includes(notNoop), deviation);
  // The namespace the attachment resolves to differs between the two recorded rows.
  const moved = productionRows();
  (
    moved.PoolWorker as unknown as { attr: { durableObjectNamespaces: Record<string, string> } }
  ).attr.durableObjectNamespaces.PoolContainer = "namespace-elsewhere";
  await refuses("two recorded namespace ids that differ", (await waits({}, moved)).plan);
  // A changed setting on the root.
  await refuses("a changed setting", (await waits({ containerInstanceType: "standard" })).plan);
  // A resolved difference in the attachment, with nothing the pool Worker waits on.
  const elsewhere = productionRows();
  (elsewhere.PoolContainer as unknown as { bindings: { sid: string; data: unknown }[] }).bindings =
    [{ sid: "PoolContainer", data: { durableObjects: { namespaceId: "namespace-elsewhere" } } }];
  await refuses(
    "a resolved difference in the attachment",
    (await planned(context, { rows: elsewhere })).plan,
  );
  // A second binding row that is not noop.
  const second = (await waits()).plan;
  (second.resources.PoolContainer as unknown as Mutable).bindings.push({
    sid: "Second",
    action: "update",
    data: {},
  });
  await refuses("a second binding row", second);
  // A known value beside the waiting namespace would hide behind the unknown.
  for (const [deviation, extend] of [
    ["a field beside the attachment", (data: Record<string, unknown>) => ({ ...data, other: "x" })],
    [
      "a field beside the namespace id",
      (data: Record<string, unknown>) => ({
        durableObjects: { ...(data.durableObjects as object), className: "Other" },
      }),
    ],
  ] as const) {
    const plan = (await waits()).plan;
    const waiting = (plan.resources.PoolContainer as unknown as Mutable).bindings[0]!;
    waiting.data = extend(waiting.data as Record<string, unknown>);
    await refuses(deviation, plan);
  }
  // And on the recorded row: a value beside the namespace there would hide behind the unknown too.
  const recordedExtra = productionRows();
  const recordedRoot = recordedExtra.PoolContainer as unknown as {
    bindings: { sid: string; data: Record<string, unknown> }[];
  };
  recordedRoot.bindings = recordedRoot.bindings.map((binding) => ({
    ...binding,
    data: { ...binding.data, other: "x" },
  }));
  await refuses("a field beside the recorded attachment", (await waits({}, recordedExtra)).plan);
  // An unknown that waits on something other than the pool Worker: the command's own outcome.
  const other = (await waits()).plan;
  const pendingCommand = (
    other.resources.PoolWorker as unknown as { props: { env: { POOL_DATABASE_READY: unknown } } }
  ).props.env.POOL_DATABASE_READY;
  (other.resources.PoolContainer as unknown as Mutable).bindings[0]!.data = {
    durableObjects: { namespaceId: pendingCommand },
  };
  await refuses("an unknown that names another row", other);
  // The pool Worker is replaced, or refused by its own rules, or no longer hosts the class.
  for (const action of ["create", "replace", "delete"]) {
    const plan = (await waits()).plan;
    (plan.resources.PoolWorker as unknown as Mutable).action = action;
    await refuses(`a pool Worker that plans ${action}`, plan);
  }
  await refuses("a pool Worker its own rules refuse", (await waits({ ledger: undefined })).plan);
  const dropped = (await waits()).plan;
  for (const binding of (dropped.resources.PoolWorker as unknown as Mutable).bindings)
    if (binding.sid === "PoolContainer") binding.action = "delete";
  await refuses("a pool Worker that no longer hosts the class", dropped);
});

test("the class change admits the root's attachment row too, and nothing else on it", async (context) => {
  const { sha256Object } = await import("alchemy/Util/sha256");
  const referenceHash = (
    await Effect.runPromise(sha256Object({ image: pinnedImage, imageName: undefined }))
  ).slice(0, 16);
  // By the class change the healing release has recorded the reference's hash on the root.
  const rows = () => {
    const recorded = productionRows();
    (recorded.PoolContainer as unknown as { attr: { hash: { image: string } } }).attr.hash.image =
      referenceHash;
    return recorded;
  };
  const rulesFor = async (plan: Plan.Plan, workerAttachment: boolean) => {
    const exit = await Effect.runPromiseExit(
      checkPlan(
        plan,
        await policy({
          mode: "cutover-classes",
          poolContainer: {
            fqn: "PoolContainer",
            image: pinnedImage,
            ...(workerAttachment ? { workerAttachment: true } : {}),
          },
        }),
      ),
    );
    return Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as PlanRefused).violations.map((v) => `${v.rule} ${v.fqn}`)
      : [];
  };
  type Row = { action: string; bindings: { sid: string; action: string; data: unknown }[] };
  // The designed cause, on every class change: a class new to the pool Worker has no namespace
  // yet, so the provider does not promise the class map and the root's attachment waits on the
  // Worker, whose node then also creates the class. And lane 1's cause, a setting that waits.
  for (const [cause, plan] of [
    [
      "a class new to the pool Worker",
      (await planned(context, { rows: rows(), declared: { newClass: true } })).plan,
    ],
    [
      "the fleet's classes",
      (await planned(context, { rows: rows(), declared: { fleetClasses: true } })).plan,
    ],
    [
      "a setting that waits on a command",
      (
        await planned(context, {
          rows: recordsReadiness(rows()),
          declared: { poolWorkerWaitsOnCommand: true },
        })
      ).plan,
    ],
  ] as const) {
    const root = plan.resources.PoolContainer as unknown as Row;
    assert.equal(root.action, "update", cause);
    const pending = root.bindings.filter((binding) => binding.action !== "noop");
    assert.deepEqual(
      pending.map(({ sid, action }) => `${sid}: ${action}`),
      ["PoolContainer: update"],
      cause,
    );
    assert.deepEqual(Object.keys(Output.upstreamAny(pending[0]!.data)), ["PoolWorker"], cause);
    if (cause !== "a setting that waits on a command")
      assert.ok(
        (plan.resources.PoolWorker as unknown as Row).bindings.some(
          (binding) => binding.action === "create",
        ),
        `${cause}: the pool Worker creates the class`,
      );
    const admitted = await rulesFor(plan, true);
    assert.ok(!admitted.includes("pool-container-not-noop PoolContainer"), `${cause}: ${admitted}`);
    assert.ok(!admitted.includes("outside-cutover-classes PoolContainer"), `${cause}: ${admitted}`);
    const refused = await rulesFor(plan, false);
    assert.ok(refused.includes("pool-container-not-noop PoolContainer"), `${cause}: ${refused}`);
    assert.ok(refused.includes("outside-cutover-classes PoolContainer"), `${cause}: ${refused}`);
  }
});

/** A row as an apply that stopped mid-update leaves it: `old` holds the last finished generation. */
const interrupted = (
  row: ResourceState,
  finished: { readonly bindings: readonly unknown[]; readonly attr?: Record<string, unknown> },
  unfinished: readonly unknown[],
) => {
  const current = row as unknown as { props: unknown; attr: Record<string, unknown> };
  return {
    ...current,
    status: "updating",
    bindings: unfinished,
    old: {
      props: current.props,
      bindings: finished.bindings,
      attr: { ...current.attr, ...finished.attr },
    },
  } as unknown as ResourceState;
};
const rulesOf = async (plan: Plan.Plan, changes: Record<string, unknown>) => {
  const exit = await Effect.runPromiseExit(checkPlan(plan, await policy(changes)));
  return Exit.isFailure(exit)
    ? (Cause.squash(exit.cause) as PlanRefused).violations.map((v) => `${v.rule} ${v.fqn}`)
    : [];
};
type Rows = { bindings: { sid: string; action: string; data: unknown }[] };

test("a row an interrupted apply left updating is judged against its last finished generation", async (context) => {
  const healing = {
    mode: "code-only",
    poolContainer: {
      fqn: "PoolContainer",
      image: pinnedImage,
      recordedHashOnly: true,
      workerAttachment: true,
    },
  };
  // The root's unfinished generation already holds the planned attachment, so the planner calls the
  // row noop; the finished one, which the live application runs, is attached elsewhere.
  const moved = productionRows();
  moved.PoolContainer = interrupted(
    moved.PoolContainer!,
    {
      bindings: [
        { sid: "PoolContainer", data: { durableObjects: { namespaceId: "namespace-elsewhere" } } },
      ],
      attr: { durableObjects: { namespaceId: "namespace-elsewhere" } },
    },
    (moved.PoolContainer as unknown as Rows).bindings,
  );
  const root = (await planned(context, { rows: moved })).plan;
  assert.deepEqual(
    (root.resources.PoolContainer as unknown as Rows).bindings.map((binding) => binding.action),
    ["noop"],
    "the planner compares with the unfinished generation",
  );
  assert.ok(
    (await rulesOf(root, healing)).includes("pool-container-not-noop PoolContainer"),
    "the root's moved attachment refuses",
  );

  // The pool Worker's finished generation still binds the ledger class; the unfinished one and the
  // declaration have dropped it, so no row of the plan deletes it.
  const dropped = productionRows();
  const finished = (dropped.PoolWorker as unknown as Rows).bindings;
  dropped.PoolWorker = interrupted(
    dropped.PoolWorker!,
    { bindings: finished },
    finished.filter((binding) => binding.sid !== "PoolLedger"),
  );
  const removal = (await planned(context, { rows: dropped, declared: { ledger: undefined } })).plan;
  assert.ok(
    !(removal.resources.PoolWorker as unknown as Rows).bindings.some((b) => b.sid === "PoolLedger"),
    "no row of the plan names the ledger",
  );
  assert.ok(
    (await rulesOf(removal, healing)).includes("durable-object-class-removed PoolWorker"),
    "the class the live Worker still binds is removed",
  );

  // And the other way: the unfinished generation already binds a class the finished one never did.
  const declared = (await planned(context, { declared: { newClass: true } })).plan;
  const blue = (declared.resources.PoolWorker as unknown as Rows).bindings.find(
    (binding) => binding.sid === "PoolRuntimeBlue",
  );
  assert.ok(blue, "the declaration adds the class");
  const added = productionRows();
  const before = (added.PoolWorker as unknown as Rows).bindings;
  added.PoolWorker = interrupted(added.PoolWorker!, { bindings: before }, [
    ...before,
    { sid: "PoolRuntimeBlue", data: blue.data },
  ]);
  const creation = (await planned(context, { rows: added, declared: { newClass: true } })).plan;
  assert.ok(
    (await rulesOf(creation, healing)).includes("code-only-binding-change PoolWorker"),
    "a class new to the live Worker is a binding change",
  );
});

test("a plan that writes a container application refuses while the root's row has no name; the heal does not", async (context) => {
  const nameless = () => {
    const rows = productionRows();
    delete (rows.PoolContainer as unknown as { attr: { applicationName?: string } }).attr
      .applicationName;
    return rows;
  };
  // The class change creates the fleet's applications. The fixture models the fleet's classes but
  // not its applications, so one is added to the real plan as the stack declares it.
  const withFleetApplication = (plan: Plan.Plan) => {
    const root = plan.resources.PoolContainer as unknown as {
      resource: { FQN: string; Type: string };
    };
    (plan.resources as Record<string, unknown>).PoolRuntimeBlueApplication = {
      ...root,
      action: "create",
      resource: { ...root.resource, FQN: "PoolRuntimeBlueApplication" },
      bindings: [],
      state: undefined,
    };
    return plan;
  };
  const cutoverPolicy = {
    mode: "cutover-classes",
    poolContainer: { fqn: "PoolContainer", image: pinnedImage, workerAttachment: true },
  };
  const refusal = "root-name-unrecorded PoolRuntimeBlueApplication";
  const cutover = withFleetApplication(
    (await planned(context, { rows: nameless(), declared: { fleetClasses: true } })).plan,
  );
  assert.ok((await rulesOf(cutover, cutoverPolicy)).includes(refusal));
  const named = withFleetApplication(
    (await planned(context, { declared: { fleetClasses: true } })).plan,
  );
  assert.ok(!(await rulesOf(named, cutoverPolicy)).includes(refusal));
  // A root State does not record yet: the guard requires none there, and neither does this rule.
  const fresh = productionRows();
  delete (fresh as Record<string, unknown>).PoolContainer;
  const first = withFleetApplication(
    (await planned(context, { rows: fresh, declared: { fleetClasses: true } })).plan,
  );
  assert.ok(!(await rulesOf(first, cutoverPolicy)).includes(refusal));
  // The healing release writes no container application, so a missing name never refuses it.
  const healing = {
    mode: "code-only",
    poolContainer: {
      fqn: "PoolContainer",
      image: pinnedImage,
      recordedHashOnly: true,
      workerAttachment: true,
    },
  };
  const heal = (
    await planned(context, {
      rows: recordsReadiness(nameless()),
      declared: { poolWorkerWaitsOnCommand: true },
    })
  ).plan;
  assert.ok(
    !(await rulesOf(heal, healing)).some((rule) => rule.startsWith("root-name-unrecorded")),
  );
});

test("a healing release drops exactly the one named plain setting the deleted layer left, and no other binding", async (context) => {
  const withRecorded = (sid: string, entry: Record<string, unknown>) => {
    const rows = productionRows();
    (rows.PoolWorker as unknown as { bindings: { sid: string; data: unknown }[] }).bindings.push({
      sid,
      data: { bindings: [{ name: sid, ...entry }] },
    });
    return rows;
  };
  const named = [{ fqn: "PoolWorker", sid: "POOL_PRESERVE_LEGACY_IMAGE", reason: "unread" }];
  const healing = { mode: "code-only", removedBindings: named };
  const removedRules = async (rows: ReturnType<typeof productionRows>, changes = healing) => {
    const plan = (await planned(context, { rows })).plan;
    const removal = (plan.resources.PoolWorker as unknown as Rows).bindings.find(
      (binding) => binding.action === "delete",
    );
    assert.ok(removal, "the plan removes a binding");
    return (await rulesOf(plan, changes)).filter((rule) => rule.includes("removed"));
  };
  const plain = { type: "plain_text", text: "true" };
  // The named setting, plain text: admitted.
  assert.deepEqual(await removedRules(withRecorded("POOL_PRESERVE_LEGACY_IMAGE", plain)), []);
  // Without the policy naming it, another name, or the name holding a secret: refused.
  assert.deepEqual(
    await removedRules(withRecorded("POOL_PRESERVE_LEGACY_IMAGE", plain), {
      mode: "code-only",
    } as never),
    ["worker-binding-removed PoolWorker"],
  );
  assert.deepEqual(await removedRules(withRecorded("POOL_CANDIDATE_APPLICATION_ID", plain)), [
    "worker-binding-removed PoolWorker",
  ]);
  assert.deepEqual(
    await removedRules(withRecorded("POOL_PRESERVE_LEGACY_IMAGE", { type: "secret_text" })),
    ["worker-binding-removed PoolWorker"],
  );
});

test("a healing release drops the publication receipt's row the deleted layer left, and no other command", async (context) => {
  const leftover = (fqn: string) => {
    const rows = productionRows() as Record<string, unknown>;
    rows[fqn] = {
      resourceType: "Command.Exec",
      fqn,
      logicalId: fqn,
      namespace: undefined,
      instanceId: fqn.toLowerCase().padEnd(32, "0").slice(0, 32),
      providerVersion: 0,
      status: "updated",
      downstream: [],
      bindings: [],
      props: { command: "node capture-pool-image.ts" },
      attr: {},
    };
    return rows as ReturnType<typeof productionRows>;
  };
  const healing = {
    mode: "code-only",
    allow: [{ fqn: "PoolImagePublicationReceipt", action: "delete" }],
  };
  const receipt = (await planned(context, { rows: leftover("PoolImagePublicationReceipt") })).plan;
  const receiptRow = (receipt.deletions as Record<string, { action?: string } | undefined>)
    .PoolImagePublicationReceipt;
  assert.equal(receiptRow?.action, "delete", "the plan deletes the leftover row");
  assert.ok(
    !(await rulesOf(receipt, healing)).some((rule) => rule.endsWith("PoolImagePublicationReceipt")),
  );
  // Any other command the stack no longer declares still refuses.
  const other = (await planned(context, { rows: leftover("SomeOtherReceipt") })).plan;
  assert.ok((await rulesOf(other, healing)).includes("outside-code-only SomeOtherReceipt"));
});

test("a named removed binding is exactly one plain setting of that name, in every generation State holds", async (context) => {
  const SID = "POOL_PRESERVE_LEGACY_IMAGE";
  const healing = {
    mode: "code-only",
    removedBindings: [{ fqn: "PoolWorker", sid: SID, reason: "unread" }],
  };
  type Recorded = { bindings: { sid: string; data: unknown }[] } & Record<string, unknown>;
  const worker = () => productionRows().PoolWorker as unknown as Recorded;
  const withRow = (entries: unknown[] | undefined): Recorded => ({
    ...worker(),
    bindings: [
      ...worker().bindings,
      ...(entries ? [{ sid: SID, data: { bindings: entries } }] : []),
    ],
  });
  const removed = async (poolWorker: Recorded) => {
    const rows = { ...productionRows(), PoolWorker: poolWorker } as unknown as ReturnType<
      typeof productionRows
    >;
    const plan = (await planned(context, { rows })).plan;
    // One violation per wire entry of the row; the verdict is the set of rules.
    return [...new Set((await rulesOf(plan, healing)).filter((rule) => rule.includes("removed")))];
  };
  const plain = { type: "plain_text", name: SID, text: "true" };
  const other = { type: "plain_text", name: "POOL_IMAGE_HASH", text: "x" };
  const secret = { type: "secret_text", name: SID };
  // The control: the named setting, plain text, is admitted.
  assert.deepEqual(await removed(withRow([plain])), []);
  // The row holds a plain setting of another name, alone or beside the named one, or one with no name.
  for (const entries of [[other], [plain, other], [{ type: "plain_text", text: "x" }]])
    assert.deepEqual(
      await removed(withRow(entries)),
      ["worker-binding-removed PoolWorker"],
      JSON.stringify(entries),
    );
  // An interrupted apply: the unfinished generation holds the id as plain text, the last finished
  // one, which may be what is live, holds a secret under it.
  assert.deepEqual(
    await removed({ ...withRow([plain]), status: "updating", old: withRow([secret]) }),
    ["worker-binding-removed PoolWorker"],
  );
});

// Plan B, the read-only plan of main a3368da9's parent on production (run 44965064800): every row
// kind it recorded, by type and action. Its 25 rows were 18 Worker updates, the root's attachment
// row, PoolWorker and five commands (Migrations, PoolDatabase, the two budgets and the readiness).
const planBKinds = [
  ["Cloudflare.Container", "update"],
  ["Cloudflare.Worker", "update"],
  ["Command.Build", "update"],
  ["Command.Exec", "update"],
];

test("the code release admits a whole-stack plan of main and still refuses what it refused before", async (context) => {
  // The reviewed file itself, with the pin the release supplies at run time.
  const file = async (change: (check: Record<string, unknown>) => Record<string, unknown>) => {
    const { check } = decodeReleasePolicy(
      JSON.parse(await readFile(new URL("./policies/code.json", import.meta.url), "utf8")),
    );
    return Effect.runPromise(
      decodePlanPolicy(
        change({ ...check, poolContainer: { ...check.poolContainer, image: pinnedImage } }),
      ),
    );
  };
  const code = await file((check) => check);
  // The same file without its two admissions: the code policy as it was before.
  const before = await file((check) => ({
    ...check,
    allow: [],
    poolContainer: { fqn: "PoolContainer", image: pinnedImage },
  }));
  const rules = async (plan: Plan.Plan, against: typeof code) => {
    const exit = await Effect.runPromiseExit(checkPlan(plan, against));
    return Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as PlanRefused).violations.map((v) => `${v.rule} ${v.fqn}`).sort()
      : [];
  };
  const { sha256Object } = await import("alchemy/Util/sha256");
  const reference = (
    await Effect.runPromise(sha256Object({ image: pinnedImage, imageName: undefined }))
  ).slice(0, 16);
  // Production after the healing release: the root's recorded hash names the reference.
  const rows = () => {
    const recorded = productionRows();
    (recorded.PoolContainer as unknown as { attr: { hash: { image: string } } }).attr.hash.image =
      reference;
    return recorded;
  };
  const notNoop = "pool-container-not-noop PoolContainer";
  const storeOutside = "outside-code-only ArtifactsCredentials";

  // 1. A whole-stack release of main: every changed Worker, the bulk-import store's code, the
  // commands, and the root's attachment that waits on the pool database command. All admitted.
  const whole = (
    await planned(context, {
      rows: recordsReadiness(rows()),
      declared: { poolWorkerWaitsOnCommand: true },
    })
  ).plan;
  assert.equal(whole.resources.ArtifactsCredentials?.action, "update");
  assert.equal(whole.resources.PoolContainer?.action, "update");
  assert.deepEqual(await rules(whole, code), [], "the code release admits the whole plan");
  const then = await rules(whole, before);
  assert.ok(then.includes(notNoop) && then.includes(storeOutside), then.join(", "));
  // Every row kind plan B recorded is a kind this admitted plan carries.
  const kinds = new Set(
    Object.values(whole.resources)
      .filter((node) => node.action !== "noop")
      .map((node) => `${node.resource.Type} ${node.action}`),
  );
  for (const [type, action] of planBKinds)
    if (type !== "Command.Build")
      assert.ok(kinds.has(`${type} ${action}`), `plan B's ${type} ${action} is covered`);
  // The fixture stack declares no site build; the code-only rule admits every Command update alike.
  assert.ok(planBKinds.some(([type]) => type === "Command.Build"));

  // 2. Everything else it refused before, it still refuses, by the same rules, apart from the
  // attachment row a plan that updates the pool Worker can also carry.
  for (const [deviation, input] of [
    ["a class change on the pool Worker", { declared: { newClass: true } }],
    ["the fleet classes declared", { declared: { fleetClasses: true } }],
    ["a changed setting on the root", { declared: { containerInstanceType: "standard" } }],
    ["the root's old recorded hash", { rows: productionRows() }],
    [
      "a class moved to another Worker",
      {
        declared: { ledger: { className: "PoolLedger", transferredFrom: "ArtifactsCredentials" } },
      },
    ],
    ["a replace of the vault bucket", { declared: { bucketJurisdiction: "default" } }],
    ["a delete of the retained Secrets Store", { declared: { observationStore: false } }],
  ] as const) {
    const plan = (
      await planned(context, { rows: rows(), settle: onlyStore, ...input } as PlanInput)
    ).plan;
    const now = await rules(plan, code);
    const was = await rules(plan, before);
    assert.ok(now.length > 0, `${deviation}: refused`);
    assert.deepEqual(
      was.filter((rule) => !now.includes(rule) && rule !== notNoop),
      [],
      `${deviation}: only the attachment row is newly admitted`,
    );
    assert.deepEqual(
      now.filter((rule) => !was.includes(rule)),
      [],
      `${deviation}: nothing new refuses`,
    );
  }
  // A write to the root's application is the wire guard's, under every policy: deploy.ts holds the
  // root's recorded application from the policy's root fqn, and "the root application is never
  // patched, rolled out or deleted" (wire-guard.test.ts) refuses every such write.
  assert.equal(code.poolContainer.fqn, "PoolContainer");
});
