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
      poolContainer: { fqn: "PoolContainer", image: pinnedImage },
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

test("a class transferred from another Worker is refused", async (context) => {
  const { plan } = await planned(context, {
    declared: { ledger: { className: "PoolLedger", transferredFrom: "ArtifactsCredentials" } },
  });
  assert.deepEqual((await refused(plan)).rules, ["durable-object-class-transferred PoolWorker"]);
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
  for (const types of [["Cloudflare.R2.Bucket"], ["Cloudflare.R2.*"]])
    assert.deepEqual((await refused(plan, { protected: { fqns, types } })).rules, [
      "protected-resource-destroyed ScratchRecords",
      "unreviewed-removal ScratchRecords",
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
