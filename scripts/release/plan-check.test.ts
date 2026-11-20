import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { isResolved } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import type * as Plan from "alchemy/Plan";
import type { ResourceState } from "alchemy/State/ResourceState";
import { Cause, Effect, Exit } from "effect";
import { checkPlan, decodePlanPolicy, planDigest, PlanRefused, propChanges } from "./plan-check.ts";
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

// The bulk-import store's Worker in production's forms: the tools Worker it calls, a secret, a
// redacted value that carries the release's version and a JSON value. Its State row is the one
// Alchemy's own apply records for that declaration, then marked as built from another checkout.
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
const credentialsRows = async (
  context: TestContext,
  builtElsewhere: readonly string[] = ["Api", "Catalog", "ArtifactsCredentials"],
) => {
  const settled = await makePlan(context, {
    rows: { ...productionRows(), ...calledRows() },
    declared: { credentials: {} },
    settle: ["Api", "Catalog", "ArtifactsCredentials"],
  });
  return withCodeFromElsewhere(settled.rows, builtElsewhere);
};
const credentialsPlan = async (
  context: TestContext,
  credentials: NonNullable<PlanInput["declared"]>["credentials"] = {},
  rows?: Readonly<Record<string, ResourceState>>,
) =>
  (
    await makePlan(context, {
      rows: rows ?? (await credentialsRows(context)),
      declared: { credentials },
    })
  ).plan;
type StoreProps = { main: string; env: Record<string, Record<string, unknown>> };
/** The same rows with the store's recorded props changed. Copied by spread: a clone unwraps secrets. */
const withStoreProps = (
  rows: Readonly<Record<string, ResourceState>>,
  change: (props: StoreProps) => StoreProps,
): Record<string, ResourceState> => {
  const store = rows.ArtifactsCredentials as unknown as { props: StoreProps };
  return {
    ...rows,
    ArtifactsCredentials: { ...store, props: change(store.props) } as unknown as ResourceState,
  };
};
type RowData = Record<string, unknown> & { bindings: Record<string, unknown>[] };
/** The same rows with one of the store's recorded binding rows changed. */
const withStoreBinding = (
  rows: Readonly<Record<string, ResourceState>>,
  sid: string,
  change: (data: RowData) => unknown,
): Record<string, ResourceState> => {
  const store = rows.ArtifactsCredentials as unknown as {
    bindings: { sid: string; data: RowData }[];
  };
  return {
    ...rows,
    ArtifactsCredentials: {
      ...store,
      bindings: store.bindings.map((binding) =>
        binding.sid === sid ? { ...binding, data: change(binding.data) } : binding,
      ),
    } as unknown as ResourceState,
  };
};
const credentialsNode = (plan: Plan.Plan) =>
  plan.resources.ArtifactsCredentials as unknown as {
    action: string;
    props: { main: string; env: Record<string, unknown> };
    bindings: { sid: string; action: string; data: RowData }[];
  };
/** Admitted under the allowance; a refusal fails with the lines that name what exceeded it. */
const storeCodeMoves = async (
  plan: Plan.Plan,
  codeOnly: Record<string, unknown> = {},
  also: readonly object[] = [],
) => {
  const exit = await Effect.runPromiseExit(
    checkPlan(plan, await policy(allowance(codeOnly, also))),
  );
  if (Exit.isFailure(exit)) assert.fail(String((Cause.squash(exit.cause) as Error).message));
  assert.ok(exit.value.some((change) => change.fqn === "ArtifactsCredentials"));
};
const exceeded = async (
  plan: Plan.Plan,
  codeOnly: Record<string, unknown> = {},
  also: readonly object[] = [],
) => {
  const { rules, message } = await refused(plan, allowance(codeOnly, also));
  assert.ok(rules.includes("code-only-allowance-exceeded ArtifactsCredentials"), rules.join(", "));
  return { rules, message };
};
// The rows of what the store refers to are other rules' to admit; these name them for a test.
const database = [{ fqn: "PoolModelDatabaseConnection", action: "update" }];
const bucket = [{ fqn: "VaultAttachments", action: "update" }];
/**
 * A plan in which the model database connection's origin moved, as it does on a test stage. The
 * store's entry for it is then the connection itself, not known until that applies, and the
 * entry's own binding row waits too.
 */
const databaseMoves = async (
  context: TestContext,
  rows?: Readonly<Record<string, ResourceState>>,
) => {
  const plan = await credentialsPlan(context, { databaseHost: "another-host.invalid" }, rows);
  assert.equal(plan.resources.PoolModelDatabaseConnection?.action, "update");
  const node = credentialsNode(plan);
  assert.equal(isResolved(node.props.env.POOL_AUTH_DATABASE), false);
  const row = node.bindings.find((binding) => binding.sid === "POOL_AUTH_DATABASE");
  assert.ok(row);
  assert.equal(row.action, "update");
  return { plan, node, row };
};
const refusesDatabase = async (plan: Plan.Plan, codeOnly: Record<string, unknown> = {}) => {
  const { rules, message } = await exceeded(plan, codeOnly, database);
  assert.deepEqual(rules, ["code-only-allowance-exceeded ArtifactsCredentials"]);
  return message;
};

test("a code-only allowance admits the bulk-import store's code while a Worker it calls updates", async (context) => {
  const plan = await credentialsPlan(context);
  const node = credentialsNode(plan);
  assert.equal(node.action, "update");
  assert.equal(plan.resources.Api?.action, "update");
  // What Alchemy plans for a reference to a resource that updates: not known until that applies.
  assert.equal(isResolved(node.props.env.TOOLS_SERVICE), false);
  assert.deepEqual(
    node.bindings.filter((binding) => binding.action !== "noop"),
    [],
  );
  await storeCodeMoves(plan);
  // The entry has to be named, and named for the resource it waits on.
  assert.match((await exceeded(plan, { references: [] })).message, /props\.env\.TOOLS_SERVICE: /u);
  assert.match(
    (await exceeded(plan, { references: [{ name: "TOOLS_SERVICE", resource: "Catalog" }] }))
      .message,
    /props\.env\.TOOLS_SERVICE: /u,
  );
});

test("a code-only allowance admits a reference that is the called Worker's own recorded attributes", async (context) => {
  // Only the store's code moved; the Worker it calls is unchanged and resolves at plan time.
  const rows = await credentialsRows(context, ["ArtifactsCredentials"]);
  const settled = await credentialsPlan(context, {}, rows);
  assert.equal(settled.resources.Api?.action, "noop");
  assert.ok(isResolved(credentialsNode(settled).props.env.TOOLS_SERVICE));
  await storeCodeMoves(settled);
  // State kept an older copy of those attributes: the called Worker moved in a release that left
  // the store alone. The entry is still that Worker, and its binding is unchanged.
  const stale = withStoreProps(rows, (props) => ({
    ...props,
    env: {
      ...props.env,
      TOOLS_SERVICE: { ...props.env.TOOLS_SERVICE, url: "https://older.invalid" },
    },
  }));
  const older = await credentialsPlan(context, {}, stale);
  await storeCodeMoves(older);
  assert.match((await exceeded(older, { references: [] })).message, /TOOLS_SERVICE\.url/u);
});

test("a code-only allowance admits the database connection's binding while that connection updates", async (context) => {
  const rows = await credentialsRows(context);
  const { plan, node, row } = await databaseMoves(context, rows);
  assert.deepEqual(
    node.bindings.filter((binding) => binding.action !== "noop").map(({ sid }) => sid),
    ["POOL_AUTH_DATABASE"],
  );
  // What the upload carries of the row is known. Only the copy of the connection's origin that
  // local development reads waits on the connection.
  assert.ok(isResolved(row.data.bindings));
  assert.deepEqual(
    Object.keys(row.data).filter((key) => !isResolved(row.data[key])),
    ["hyperdrives"],
  );
  await storeCodeMoves(plan, {}, database);
  // State from a release that recorded no such copy holds the same binding.
  const bare = withStoreBinding(
    rows,
    "POOL_AUTH_DATABASE",
    ({ hyperdrives: _none, ...data }) => data,
  );
  await storeCodeMoves((await databaseMoves(context, bare)).plan, {}, database);
  // Unnamed, or named for another resource, both the entry and its binding refuse.
  for (const references of [
    [{ name: "TOOLS_SERVICE", resource: "Api" }],
    [
      { name: "TOOLS_SERVICE", resource: "Api" },
      { name: "POOL_AUTH_DATABASE", resource: "Api" },
    ],
  ]) {
    const message = await refusesDatabase(plan, { references });
    assert.match(message, /bindings\.POOL_AUTH_DATABASE: update/u);
    assert.match(message, /props\.env\.POOL_AUTH_DATABASE: /u);
  }
});

test("a code-only allowance admits a reference's binding that differs only in local development's copy of the origin", async (context) => {
  // State from a release that recorded that copy in another form, or not at all. The connection
  // itself is unchanged, so the whole plan is known, and the planner still marks the row changed.
  const rows = await credentialsRows(context, ["ArtifactsCredentials"]);
  const row = (plan: Plan.Plan) => {
    assert.equal(plan.resources.PoolModelDatabaseConnection?.action, "noop");
    const node = credentialsNode(plan);
    assert.ok(isResolved(node.props.env.POOL_AUTH_DATABASE));
    const found = node.bindings.find((binding) => binding.sid === "POOL_AUTH_DATABASE");
    assert.equal(found?.action, "update");
    assert.ok(isResolved(found?.data));
    return found;
  };
  const older = (data: RowData) =>
    Object.fromEntries(
      Object.entries(data.hyperdrives as Record<string, object>).map(([id, origin]) => [
        id,
        { ...origin, host: "older-host.invalid" },
      ]),
    );
  for (const change of [
    ({ hyperdrives: _none, ...data }: RowData) => data,
    (data: RowData) => ({ ...data, hyperdrives: {} }),
    (data: RowData) => ({ ...data, hyperdrives: older(data) }),
  ]) {
    const plan = await credentialsPlan(
      context,
      {},
      withStoreBinding(rows, "POOL_AUTH_DATABASE", change),
    );
    row(plan);
    await storeCodeMoves(plan);
    // The entry has to be named for it.
    const unnamed = await exceeded(plan, {
      references: [{ name: "TOOLS_SERVICE", resource: "Api" }],
    });
    assert.match(unnamed.message, /bindings\.POOL_AUTH_DATABASE: update/u);
  }
  // With that copy gone, what the upload carries still has to be as State recorded it.
  for (const change of [
    // Another connection.
    ({ hyperdrives: _none, ...data }: RowData) => ({
      ...data,
      bindings: data.bindings.map((entry) => ({ ...entry, id: "5".repeat(32) })),
    }),
    // A second wire entry, and a key the plan does not carry.
    ({ hyperdrives: _none, ...data }: RowData) => ({
      ...data,
      bindings: [...data.bindings, { type: "plain_text", name: "MODE", text: "before" }],
    }),
    ({ hyperdrives: _none, ...data }: RowData) => ({ ...data, extra: true }),
  ]) {
    const plan = await credentialsPlan(
      context,
      {},
      withStoreBinding(rows, "POOL_AUTH_DATABASE", change),
    );
    row(plan);
    assert.match((await exceeded(plan)).message, /bindings\.POOL_AUTH_DATABASE: update/u);
  }
});

test("a code-only allowance refuses a database connection that State recorded as another one", async (context) => {
  const settled = await credentialsRows(context);
  const other = "5".repeat(32);
  const rowMoved = withStoreBinding(settled, "POOL_AUTH_DATABASE", (data) => ({
    ...data,
    bindings: data.bindings.map((entry) => ({ ...entry, id: other })),
  }));
  for (const rows of [
    // State holds another connection under the entry and in its binding row.
    withStoreProps(rowMoved, (props) => ({
      ...props,
      env: {
        ...props.env,
        POOL_AUTH_DATABASE: { ...props.env.POOL_AUTH_DATABASE, hyperdriveId: other },
      },
    })),
    // The binding row alone: it is what the upload before carried.
    rowMoved,
  ]) {
    const message = await refusesDatabase((await databaseMoves(context, rows)).plan);
    assert.match(message, /bindings\.POOL_AUTH_DATABASE: update/u);
    assert.match(message, /props\.env\.POOL_AUTH_DATABASE: /u);
  }
});

test("a code-only allowance refuses a waiting binding row that State recorded with more or less", async (context) => {
  const settled = await credentialsRows(context);
  for (const change of [
    // A second wire entry under the reference's own row.
    (data: RowData) => ({
      ...data,
      bindings: [...data.bindings, { type: "plain_text", name: "MODE", text: "before" }],
    }),
    // A key the plan no longer carries.
    (data: RowData) => ({ ...data, extra: true }),
    // No wire entry at all.
    (data: RowData) => ({ ...data, bindings: [] }),
    // A wire entry without the connection's id.
    (data: RowData) => ({
      ...data,
      bindings: data.bindings.map(({ id: _none, ...entry }) => entry),
    }),
  ]) {
    const rows = withStoreBinding(settled, "POOL_AUTH_DATABASE", change);
    const message = await refusesDatabase((await databaseMoves(context, rows)).plan);
    assert.match(message, /bindings\.POOL_AUTH_DATABASE: update/u);
  }
});

test("a code-only allowance refuses a waiting binding row that carries more than the reference", async (context) => {
  const settled = await credentialsRows(context);
  type Waiting = Awaited<ReturnType<typeof databaseMoves>>;
  for (const change of [
    // Code that contributes a second wire entry under the reference's own row.
    ({ row }: Waiting) => {
      row.data = {
        ...row.data,
        bindings: [...row.data.bindings, { type: "plain_text", name: "MODE", text: "next" }],
      };
    },
    // A wire entry that is not known yet: the upload would carry whatever it turns out to be.
    ({ row }: Waiting) => {
      row.data = {
        ...row.data,
        bindings: row.data.bindings.map((entry) => ({ ...entry, id: row.data.hyperdrives })),
      };
    },
    // A row that is not known as a whole, though it waits on the named connection alone.
    ({ row }: Waiting) => {
      row.data = row.data.hyperdrives as RowData;
    },
    // Something not known under a key that is not local development's copy of the origin.
    ({ row }: Waiting) => {
      row.data = { ...row.data, devRemote: row.data.hyperdrives };
    },
    // That copy waiting on another resource than the named one.
    ({ row, node }: Waiting) => {
      assert.equal(isResolved(node.props.env.TOOLS_SERVICE), false);
      row.data = { ...row.data, hyperdrives: node.props.env.TOOLS_SERVICE };
    },
  ]) {
    const waiting = await databaseMoves(context, settled);
    change(waiting);
    const message = await refusesDatabase(waiting.plan);
    assert.match(message, /bindings\.POOL_AUTH_DATABASE: update/u);
    assert.match(message, /props\.env\.POOL_AUTH_DATABASE: /u);
  }
});

test("a code-only allowance refuses an entry that only derives from the resource, or has no binding of its own", async (context) => {
  const settled = await credentialsRows(context);
  // Not the connection itself: a value computed from it, which can be anything once known.
  const derived = await databaseMoves(context, settled);
  derived.node.props.env.POOL_AUTH_DATABASE = derived.row.data.hyperdrives;
  assert.match(await refusesDatabase(derived.plan), /props\.env\.POOL_AUTH_DATABASE: /u);
  // Which resource the upload binds is read from the entry's binding row. Without one, nothing says.
  const unbound = await databaseMoves(context, settled);
  unbound.node.bindings = unbound.node.bindings.filter(
    (binding) => binding.sid !== "POOL_AUTH_DATABASE",
  );
  const { message } = await exceeded(unbound.plan, {}, database);
  assert.match(message, /props\.env\.POOL_AUTH_DATABASE: /u);
});

test("a code-only allowance refuses a named bucket's binding while that bucket updates", async (context) => {
  // A bucket's binding carries more than a stable identity: its wire entry holds the bucket's
  // jurisdiction, which is not known while the bucket updates. The upload would carry whatever
  // that turns out to be, so the row is refused though the policy names the entry.
  const moves = (rows: Readonly<Record<string, ResourceState>>) =>
    makePlan(context, {
      rows,
      declared: { credentials: {}, bucketStorageClass: "InfrequentAccess" },
    });
  const settled = await credentialsRows(context);
  const other = "basalt-production-otherbucket";
  for (const rows of [
    settled,
    // State holds the same bucket name in another jurisdiction.
    withStoreBinding(settled, "VAULT", (data) => ({
      ...data,
      bindings: data.bindings.map((entry) => ({ ...entry, jurisdiction: "eu" })),
    })),
    // State holds another bucket under the entry.
    withStoreBinding(
      withStoreProps(settled, (props) => ({
        ...props,
        env: { ...props.env, VAULT: { ...props.env.VAULT, bucketName: other } },
      })),
      "VAULT",
      (data) => ({
        ...data,
        bindings: data.bindings.map((entry) => ({ ...entry, bucketName: other })),
      }),
    ),
  ]) {
    const { plan } = await moves(rows);
    assert.equal(plan.resources.VaultAttachments?.action, "update");
    const node = credentialsNode(plan);
    assert.equal(isResolved(node.props.env.VAULT), false);
    const row = node.bindings.find((binding) => binding.sid === "VAULT");
    assert.equal(row?.action, "update");
    assert.equal(isResolved(row?.data.bindings), false);
    const { rules, message } = await refused(plan, allowance({}, bucket));
    assert.deepEqual(rules, ["code-only-allowance-exceeded ArtifactsCredentials"]);
    assert.match(message, /bindings\.VAULT: update/u);
    assert.match(message, /props\.env\.VAULT: /u);
  }
});

test("a code-only allowance admits an older recorded copy of the called Worker and refuses another Worker", async (context) => {
  const settled = await credentialsRows(context);
  // State kept an older copy of the called Worker's attributes, also of those an update cannot
  // change: that Worker was replaced, and gained a class, in releases that left the store alone.
  // The store still binds the same Worker by name, so its binding row is unchanged.
  const stale = withStoreProps(settled, (props) => ({
    ...props,
    env: {
      ...props.env,
      TOOLS_SERVICE: {
        ...props.env.TOOLS_SERVICE,
        workerId: "an-older-worker-id",
        durableObjectNamespaces: { Older: "0".repeat(32) },
      },
    },
  }));
  const older = await credentialsPlan(context, {}, stale);
  assert.equal(older.resources.Api?.action, "update");
  assert.equal(isResolved(credentialsNode(older).props.env.TOOLS_SERVICE), false);
  assert.deepEqual(
    credentialsNode(older).bindings.filter((binding) => binding.action !== "noop"),
    [],
  );
  await storeCodeMoves(older);
  // State holds another Worker under the entry and in its binding row; the declaration calls the
  // named one, which updates, so the entry in the plan waits on the named Worker alone.
  const catalog = (settled.Catalog as unknown as { attr: Record<string, unknown> }).attr;
  const moved = withStoreBinding(
    withStoreProps(settled, (props) => ({
      ...props,
      env: { ...props.env, TOOLS_SERVICE: { ...catalog } },
    })),
    "TOOLS_SERVICE",
    (data) => ({
      ...data,
      bindings: data.bindings.map((entry) => ({ ...entry, service: catalog.workerName })),
    }),
  );
  const plan = await credentialsPlan(context, {}, moved);
  assert.equal(plan.resources.Api?.action, "update");
  assert.equal(isResolved(credentialsNode(plan).props.env.TOOLS_SERVICE), false);
  const { message } = await exceeded(plan);
  // The entry itself refuses, not only the binding row that happens to be known for a Worker.
  assert.match(message, /props\.env\.TOOLS_SERVICE: /u);
  assert.match(message, /bindings\.TOOLS_SERVICE: update/u);
});

test("a code-only allowance admits only the named field of a value, never the credential beside it", async (context) => {
  // The redacted value holds the release's version and a telemetry credential.
  const { message } = await exceeded(await credentialsPlan(context, { token: "token-b" }));
  assert.match(message, /bindings\.EXECUTOR_TELEMETRY: update/u);
  assert.match(message, /props\.env\.EXECUTOR_TELEMETRY: <redacted> -> <redacted>/u);
  await exceeded(await credentialsPlan(context, { version: "2", token: "token-b" }));
  // A field the policy does not name is not admitted because another one is.
  await exceeded(await credentialsPlan(context, { version: "2" }), {
    values: [{ name: "EXECUTOR_TELEMETRY", fields: ["environment"], why: "another field" }],
  });
  // The same value as another kind of binding is not the same binding.
  const plain = await exceeded(
    await credentialsPlan(context, { version: "2", telemetryPlain: true }),
  );
  assert.match(plain.message, /bindings\.EXECUTOR_TELEMETRY: update/u);
  // A named value has to be there on both sides: State without it means the entry is new.
  const rows = await credentialsRows(context);
  const store = rows.ArtifactsCredentials as unknown as { bindings: { sid: string }[] };
  const { EXECUTOR_TELEMETRY: _dropped, ...env } = (
    store as unknown as { props: { env: Record<string, Record<string, unknown>> } }
  ).props.env;
  const added = await exceeded(
    await credentialsPlan(
      context,
      {},
      {
        ...withStoreProps(rows, (props) => ({ ...props, env })),
        ArtifactsCredentials: {
          ...withStoreProps(rows, (props) => ({ ...props, env })).ArtifactsCredentials,
          bindings: store.bindings.filter((binding) => binding.sid !== "EXECUTOR_TELEMETRY"),
        } as unknown as ResourceState,
      },
    ),
  );
  assert.match(added.message, /bindings\.EXECUTOR_TELEMETRY: create/u);
  assert.match(added.message, /props\.env\.EXECUTOR_TELEMETRY: absent -> <redacted>/u);
  // A secret that is not such a record cannot be named into the list.
  const secret = await exceeded(await credentialsPlan(context, { secret: "another-secret" }), {
    values: [
      { name: "EXECUTOR_TELEMETRY", fields: ["version"], why: "the release's version" },
      { name: "POOL_APP_SIGNING_KEY", fields: ["version"], why: "not a record" },
    ],
  });
  assert.match(secret.message, /props\.env\.POOL_APP_SIGNING_KEY: <redacted> -> <redacted>/u);
});

test("a code-only allowance admits a named value that changes with the release, and its binding", async (context) => {
  const plan = await credentialsPlan(context, { version: "2" });
  // A changed value plans its own binding row as an update as well.
  assert.deepEqual(
    credentialsNode(plan).bindings.filter((binding) => binding.action !== "noop"),
    [{ sid: "EXECUTOR_TELEMETRY", action: "update" }].map((row) => ({
      ...credentialsNode(plan).bindings.find((binding) => binding.sid === row.sid),
      ...row,
    })),
  );
  await storeCodeMoves(plan);
  const { message } = await exceeded(plan, { values: [] });
  assert.match(message, /bindings\.EXECUTOR_TELEMETRY: update/u);
  assert.match(message, /props\.env\.EXECUTOR_TELEMETRY: <redacted> -> <redacted>/u);
});

test("a code-only allowance admits the same entry file under another checkout's directory", async (context) => {
  const rows = await credentialsRows(context);
  const recordedMain = (main: string) => withStoreProps(rows, (props) => ({ ...props, main }));
  const inCheckout = "scripts/release/test/plan-worker.ts";
  for (const main of [
    // As the release layer before recorded it: a path, or a file URL, under its own directory.
    `/runner/_temp/candidate/${inCheckout}`,
    `file:///runner/_temp/candidate/${inCheckout}`,
  ]) {
    const plan = await credentialsPlan(context, {}, recordedMain(main));
    assert.notEqual(credentialsNode(plan).props.main, main);
    await storeCodeMoves(plan);
  }
  // Another file is a change of the entry, wherever the checkout sits.
  for (const main of [
    "/runner/_temp/candidate/scripts/release/test/another-worker.ts",
    // The same characters at the end, without the directory boundary before them.
    "/runner/_temp/candidatescripts/release/test/plan-worker.ts",
    "/runner/_temp/candidate/scripts/other/test/plan-worker.ts",
    "/runner/_temp/candidate/plan-worker.ts",
  ]) {
    const { message } = await exceeded(await credentialsPlan(context, {}, recordedMain(main)));
    assert.match(message, /props\.main: /u, main);
    assert.ok(!message.includes("/runner/_temp"), message);
  }
  // And so is a declaration that names another file of this checkout.
  const declared = await credentialsPlan(context, {
    main: fileURLToPath(new URL("./test/plan-fixture.ts", import.meta.url)),
  });
  assert.match((await exceeded(declared)).message, /props\.main: /u);
});

test("a code-only allowance refuses a changed secret, also beside a reference that is not known yet", async (context) => {
  const plan = await credentialsPlan(context, { secret: "another-signing-secret" });
  assert.equal(isResolved(credentialsNode(plan).props.env.TOOLS_SERVICE), false);
  const { message } = await exceeded(plan);
  assert.match(message, /bindings\.POOL_APP_SIGNING_KEY: update/u);
  assert.match(message, /props\.env\.POOL_APP_SIGNING_KEY: <redacted> -> <redacted>/u);
  // One value that is not known yet does not hide the rest of the row.
  assert.ok(!message.includes("props: "), message);
  assert.ok(!message.includes("TOOLS_SERVICE"), message);
  // A secret is not a reference, whatever the policy calls it.
  const named = await exceeded(plan, {
    references: [
      { name: "TOOLS_SERVICE", resource: "Api" },
      { name: "POOL_APP_SIGNING_KEY", resource: "Api" },
    ],
  });
  assert.match(named.message, /props\.env\.POOL_APP_SIGNING_KEY: <redacted> -> <redacted>/u);
});

test("a code-only allowance cannot be declared with an empty or doubled name, or for the Worker itself", async (context) => {
  const named = (name: string, why = "a reason") => [{ name, fields: ["version"], why }];
  await assert.rejects(policy(allowance({ values: named("") })));
  await assert.rejects(policy(allowance({ values: named("EXECUTOR_TELEMETRY", " ") })));
  await assert.rejects(
    policy(allowance({ values: [{ name: "EXECUTOR_TELEMETRY", fields: [], why: "a reason" }] })),
  );
  await assert.rejects(policy(allowance({ why: "" })));
  await assert.rejects(policy(allowance({ references: [{ name: "", resource: "Api" }] })));
  const plan = await credentialsPlan(context);
  // One name in both lists would let the looser rule answer for the stricter one.
  const doubled = await exceeded(plan, {
    values: [...named("EXECUTOR_TELEMETRY"), ...named("TOOLS_SERVICE")],
  });
  assert.match(doubled.message, /policy\.TOOLS_SERVICE: named as a reference and as a value/u);
  // One name twice in a list: the second entry would answer for the first.
  const twice = await exceeded(plan, {
    references: [
      { name: "TOOLS_SERVICE", resource: "Api" },
      { name: "TOOLS_SERVICE", resource: "Catalog" },
    ],
    values: [...named("EXECUTOR_TELEMETRY"), ...named("EXECUTOR_TELEMETRY")],
  });
  assert.match(twice.message, /policy\.TOOLS_SERVICE: named twice/u);
  assert.match(twice.message, /policy\.EXECUTOR_TELEMETRY: named twice/u);
  const itself = await exceeded(plan, {
    references: [
      { name: "TOOLS_SERVICE", resource: "Api" },
      { name: "VAULT", resource: "ArtifactsCredentials" },
    ],
  });
  assert.match(itself.message, /policy\.VAULT: names the Worker itself/u);
});

test("a code-only allowance refuses a changed value that the policy does not name", async (context) => {
  const { message } = await exceeded(await credentialsPlan(context, { mode: "b" }));
  assert.match(message, /bindings\.POOL_MODE: update/u);
  assert.match(message, /props\.env\.POOL_MODE\.mode: /u);
});

test("a code-only allowance refuses a new binding and a new entry", async (context) => {
  const rows = await credentialsRows(context);
  const bound = await makePlan(context, {
    rows,
    declared: { credentials: {}, credentialsClass: "SecondCoordinator" },
  });
  const byClass = await exceeded(bound.plan);
  assert.ok(byClass.rules.includes("code-only-binding-change ArtifactsCredentials"));
  assert.match(byClass.message, /bindings\.Second: create/u);
  const entry = await makePlan(context, {
    rows,
    declared: { credentials: {}, credentialsEnv: { MODE: "next" } },
  });
  const byEntry = await exceeded(entry.plan);
  assert.match(byEntry.message, /bindings\.MODE: create/u);
  assert.match(byEntry.message, /props\.env\.MODE: absent -> /u);
});

test("a code-only allowance refuses a removed binding", async (context) => {
  // The declaration no longer holds what State recorded for the store.
  const { plan } = await makePlan(context, { rows: await credentialsRows(context) });
  const { rules, message } = await exceeded(plan);
  assert.ok(rules.includes("worker-binding-removed ArtifactsCredentials"), rules.join(", "));
  assert.match(message, /bindings\.TOOLS_SERVICE: delete/u);
  assert.match(message, /props\.env\.TOOLS_SERVICE\.workerName: .* -> absent/u);
});

test("a code-only allowance refuses a changed class and another called Worker", async (context) => {
  const renamed = await exceeded(
    await credentialsPlan(context, { className: "ArtifactsTokenCoordinatorNext" }),
  );
  assert.ok(renamed.rules.includes("durable-object-class-changed ArtifactsCredentials"));
  assert.match(renamed.message, /bindings\.Coordinator: update/u);
  // The same name bound to another Worker: its binding changes, updating or not.
  for (const builtElsewhere of [
    ["Api", "Catalog", "ArtifactsCredentials"],
    ["ArtifactsCredentials"],
  ]) {
    const plan = await credentialsPlan(
      context,
      { calls: "Catalog" },
      await credentialsRows(context, builtElsewhere),
    );
    const { message } = await exceeded(plan);
    assert.match(message, /bindings\.TOOLS_SERVICE: update/u);
    assert.match(message, /props\.env\.TOOLS_SERVICE/u);
  }
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
