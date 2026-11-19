import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type * as Plan from "alchemy/Plan";
import { Cause, Effect, Exit } from "effect";
import { checkPlan, decodePlanPolicy, planDigest, PlanRefused } from "./plan-check.ts";
import {
  accountId,
  buildContext,
  makePlan,
  pinnedImage,
  productionRows,
  recordedActionRow,
  retainedScratchRow,
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
