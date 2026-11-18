import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Effect, Schema } from "effect";
import {
  fleetAttachedFixture,
  controllerRecoveredFixture,
  fixtureAdoptionTarget,
  planSettlement,
  type SettlementFixture,
} from "./test/settlement-plan.ts";
import type { BootstrapShape } from "./test/settlement-bootstrap.ts";
import { bootstrapManifest } from "./test/settlement-bootstrap.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";
import { applyReleaseSettlement } from "./release-settlement-operation.ts";
import {
  ReleaseSettlementProof,
  releaseSettlementDigest,
  releaseSettlementKey,
} from "./release-settlement-contract.ts";
import { openReleaseSettlement } from "./release-settlement-archive.ts";
import { runtimeReleaseJournal, type RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { readBaselineController } from "./baseline-controller.ts";
import { settlementVerdict, unsettledPrior } from "./release-preflight-live.ts";
import { canonical, digest } from "./manifest.ts";
import { runtimeApplicationPins } from "./runtime-release-state.ts";
import type { RuntimeColor } from "../../src/pool/image-release-plan.ts";
import {
  FleetConfiguration as FleetConfigurationSchema,
  type FleetConfiguration,
} from "../../src/pool/runtime-fleet/configuration.ts";
import { adoptingRelease, applyFrom, planFrom } from "./test/settlement-chain.ts";

const identity = { ...fixtureAdoptionTarget, bootId: "recovered-boot-2" };
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const apply = (f: SettlementFixture, manifest: Awaited<ReturnType<typeof planSettlement>>) =>
  Effect.runPromise(
    f.provide(
      applyReleaseSettlement(
        f.compiled,
        manifest,
        f.key,
        {
          coordinatorGo: "apply-reviewed-packet",
          writerLease: f.provisioningWriter.lease,
          manifest: releaseSettlementDigest(manifest),
          expiresAt: Date.now() + 60_000,
        },
        f.io,
      ),
    ),
  );
const plan = (f: SettlementFixture) => planSettlement(f, "fleet-attached-unstarted");
/** Rewrites the source's own journal head, as a later step of its release would have. */
const rewriteSource = async (
  f: SettlementFixture,
  change: (record: RuntimeReleaseRecord) => RuntimeReleaseRecord,
) => {
  const source = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.sourceCandidate), f.key)),
  );
  await source.write(change(f.record));
};

const shapes: [string, BootstrapShape][] = [
  ["blue bootstrapped, green absent", { colors: ["blue"] }],
  ["blue bootstrapped and bound, green absent", { colors: ["blue"], bound: ["blue"] }],
  ["blue and green bootstrapped, neither bound", { colors: ["blue", "green"] }],
  [
    "blue and green bootstrapped, bound and configured",
    { colors: ["blue", "green"], bound: ["blue", "green"], configured: true },
  ],
];
for (const [name, shape] of shapes)
  test(`a recovered root with ${name} is archived once and frees only the named next candidate`, async (context) => {
    const f = await fleetAttachedFixture(context, shape);
    const next = await Effect.runPromise(
      f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
    );
    await assert.rejects(next.read(), /prior-candidate-unsettled/);
    const reads = f.runtimeReads.length;
    const manifest = await plan(f);
    assert.equal(f.writes(), 0);
    assert.ok(manifest.proof.disposition === "fleet-attached-unstarted");
    const { fleetDigest, ...controllerReads } = manifest.proof.controllerReads;
    assert.match(fleetDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(controllerReads, {
      colors: [...shape.colors],
      permission: shape.configured ? "present" : "absent",
      witness: "recovered-restart",
      selection: { epoch: 3, identity },
    });
    assert.deepEqual(
      f.runtimeReads.slice(reads).map((call) => `${call.method} ${call.action ?? call.path}`),
      ["POST inspect", "POST active-health", "POST fleet-inspect", "POST witness", "POST inspect"],
    );
    // Every bootstrapped application is proven idle and pinned in the archive.
    assert.deepEqual(
      manifest.proof.applications.map((row) => row.resource),
      [
        "PoolContainer",
        ...shape.colors.map((c) => (c === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen")),
      ],
    );
    assert.deepEqual(
      manifest.proof.nativeResources
        .map((row) => row.fqn)
        .filter((fqn) => fqn.startsWith("PoolRuntime")),
      shape.colors.map((c) => (c === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen")).sort(),
    );
    const strict = Schema.decodeUnknownSync(ReleaseSettlementProof, { onExcessProperty: "error" });
    assert.equal(strict(manifest.proof).disposition, "fleet-attached-unstarted");
    const receipt = await apply(f, manifest);
    assert.equal(receipt.stateWrites, 1);
    assert.equal(receipt.runtimeMutations, 0);
    assert.equal(f.writes(), 1);
    const archive = await Effect.runPromise(
      f.state.getOutput(releaseSettlementKey(f.scope, f.sourceCandidate, f.candidate)),
    );
    const saved = openReleaseSettlement(archive, f.key, f.sourceCandidate, f.candidate);
    assert.deepEqual(saved.manifest.proof, manifest.proof);
    // The next candidate's head names the live-proven source code, and its baseline reads with it.
    const head = await next.head();
    assert.equal(head.record, undefined);
    assert.deepEqual(head.sourceController, f.code);
    const baseline = await Effect.runPromise(
      f.provide(readBaselineController(f.compiled, head.sourceController)),
    );
    assert.deepEqual(baseline.code, f.code);
    assert.deepEqual(baseline.versions, [{ versionId: "accepted-PoolWorker", percentage: 100 }]);
    // Any other candidate is still refused.
    const other = await Effect.runPromise(
      f.provide(runtimeReleaseJournal(f.scope, f.writer("9".repeat(40)), f.key)),
    );
    await assert.rejects(other.read(), /prior-candidate-unsettled/);
  });

test("a root restarted again between plan and apply refuses apply, naming the new epoch and boot", async (context) => {
  const f = await fleetAttachedFixture(context);
  const manifest = await plan(f);
  await f.controller.restart("recovered-boot-3");
  await assert.rejects(
    apply(f, manifest),
    /release-settlement-selection-changed \(selection\.epoch\) expected=3 observed=4 observedBoot=recovered-boot-3$/,
  );
  assert.equal(f.writes(), 0);
});

test("adopt's own epoch-1 selection with blue bootstrapped is archived with its unattested witness", async (context) => {
  const f = await fleetAttachedFixture(context, { colors: ["blue"] }, { recovered: false });
  const manifest = await plan(f);
  assert.ok(manifest.proof.disposition === "fleet-attached-unstarted");
  const { controllerReads } = manifest.proof;
  assert.equal(controllerReads.witness, "unattested-adoption");
  assert.equal(controllerReads.selection.epoch, 1);
  assert.deepEqual(controllerReads.selection.identity, {
    ...fixtureAdoptionTarget,
    bootId: "baseline-boot",
  });
  const receipt = await apply(f, manifest);
  assert.equal(receipt.stateWrites, 1);
  assert.equal(f.writes(), 1);
  const head = await (
    await Effect.runPromise(f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)))
  ).head();
  assert.deepEqual(head.sourceController, f.code);
});

/**
 * A fleet runtime as the controller's target() mints it: on its colour's application pins, so its
 * image input is that application's reference input, never the selected root's.
 */
const fleetRow = (
  f: SettlementFixture,
  overrides: {
    color?: RuntimeColor;
    imageInput?: string;
    phase?: string;
    applicationId?: string;
  } = {},
) => {
  const application = f.record.baseline.applications[overrides.color ?? "blue"]!;
  const pins = runtimeApplicationPins(application.attributes, application.image.inputHash);
  return {
    target: {
      format: "pool-runtime-slot-v1",
      controllerId: fixtureAdoptionTarget.controllerId,
      slotId: "fleet-1",
      instanceId: "e".repeat(64),
      applicationId: overrides.applicationId ?? pins.applicationId,
      applicationVersion: pins.applicationVersion,
      imageDigest: pins.imageDigest,
      imageInput: overrides.imageInput ?? pins.imageInput,
      homePeerOrdinal: 1,
    },
    phase: overrides.phase ?? "ready",
    active: 2,
    lastUsedAt: 1,
  };
};
const configured: BootstrapShape = {
  colors: ["blue", "green"],
  bound: ["blue", "green"],
  configured: true,
};
const serving = (f: SettlementFixture, row = fleetRow(f)) => {
  const fleet = Schema.decodeUnknownSync(Fields)(f.controller.fleet);
  f.controller.fleet = { ...fleet, resources: [row] };
  f.serveFleet("pool-blue", 1);
};
test("a configured fleet whose permission the root's recovery since rewrote settles by content", async (context) => {
  const f = await fleetAttachedFixture(context, configured);
  const live = Schema.decodeUnknownSync(
    Schema.Struct({
      permission: Schema.Struct({
        operationId: Schema.String,
        configuration: FleetConfigurationSchema,
      }),
    }),
    { onExcessProperty: "ignore" },
  )(f.controller.fleet).permission;
  const retained = f.record.configurations[`configure-${f.sourceCandidate}`]!;
  // recoverPrimary kept the operation and rewrote legacy, revision and the chained digest twice.
  assert.equal(live.operationId, `configure-${f.sourceCandidate}`);
  assert.equal(retained.revision, 1);
  assert.equal(live.configuration.revision, 3);
  assert.equal(live.configuration.legacy.bootId, "recovered-boot-2");
  assert.notEqual(canonical(live.configuration), canonical(retained));
  const manifest = await plan(f);
  assert.ok(manifest.proof.disposition === "fleet-attached-unstarted");
  assert.equal(manifest.proof.controllerReads.permission, "present");
  assert.equal((await apply(f, manifest)).stateWrites, 1);
});

/** Rewrites the live permission's configuration, keeping its digest honest unless told not to. */
const livePermission = (
  f: SettlementFixture,
  change: (configuration: FleetConfiguration) => FleetConfiguration,
  options: { staleDigest?: boolean } = {},
) => {
  const fleet = Schema.decodeUnknownSync(Fields)(f.controller.fleet);
  const permission = Schema.decodeUnknownSync(
    Schema.Struct({ configuration: FleetConfigurationSchema }),
    { onExcessProperty: "ignore" },
  )(fleet.permission);
  const configuration = change(permission.configuration);
  f.controller.fleet = {
    ...fleet,
    permission: {
      ...Schema.decodeUnknownSync(Fields)(fleet.permission),
      configuration,
      ...(options.staleDigest ? {} : { digest: digest(canonical(configuration)) }),
    },
  };
};

test("an enabled fleet serving demand on its own application's reference input is archived, and demand moving before apply does not drift", async (context) => {
  const f = await fleetAttachedFixture(context, configured);
  serving(f);
  // Fleet runtimes run the bootstrapped application's reference input, never the root's.
  const row = fleetRow(f);
  assert.notEqual(row.target.imageInput, f.record.baseline.applications.root.image.inputHash);
  assert.equal(row.target.imageInput, f.record.baseline.applications.blue!.image.inputHash);
  const manifest = await plan(f);
  assert.ok(manifest.proof.disposition === "fleet-attached-unstarted");
  assert.equal(manifest.proof.controllerReads.permission, "present");
  // Demand scales the fleet between plan and apply: rows and instances are judged, never pinned.
  serving(f, { ...fleetRow(f), active: 7, lastUsedAt: 9 });
  f.serveFleet("pool-blue", 3);
  const receipt = await apply(f, manifest);
  assert.equal(receipt.stateWrites, 1);
  assert.equal(f.writes(), 1);
});

/** The image update a configured source's release journals before staging any startup. */
const stagedUpdate = (f: SettlementFixture, record: RuntimeReleaseRecord) => ({
  operationId: `image-${f.sourceCandidate}`,
  configurationDigest: "6".repeat(64),
  baseline: Object.values(record.configurations)[0]!.applications[1]!,
  imageDigest: `sha256:${"9".repeat(64)}`,
  imageInput: "d".repeat(16),
});
/** A promotion's startup an operator then aborted, as runtime-release-abort.ts journals it. */
const abortedStartup = async (f: SettlementFixture) => {
  const proof = await runtimeProofFixture();
  const value = await promotion(f);
  return {
    promotion: value,
    abort: {
      intent: {
        operationId: "operator-abort",
        target: value.startup.target,
        witness: proof.witness,
        startupOperationId: value.startup.operationId,
        expectedEpoch: value.startup.selection.expectedEpoch,
        active: value.startup.selection.active!,
      },
      status: "aborted" as const,
      sent: true,
    },
  };
};

const promotion = async (f: SettlementFixture) => {
  const proof = await runtimeProofFixture();
  const startup = { ...proof.manifest, candidate: f.sourceCandidate, controllerCode: f.code };
  return { operationId: startup.operationId, pool: "synthetic-pool", generation: 0, startup };
};
const rewritten = async (
  live: () => Promise<Response>,
  change: (result: Record<string, unknown>) => Record<string, unknown>,
) => {
  const response = await live();
  const { result } = Schema.decodeUnknownSync(Schema.Struct({ result: Fields }))(
    await response.json(),
  );
  return Response.json({ result: change(result) });
};
type Refusal = [string, RegExp, (f: SettlementFixture) => unknown, BootstrapShape?];
const refusals: Refusal[] = [
  [
    "a journaled promotion",
    /release-settlement-not-fleet-attached-unstarted \(record\.promotion\)/,
    async (f) => {
      const value = await promotion(f);
      await rewriteSource(f, (record) => ({ ...record, promotion: value }));
    },
  ],
  [
    "a staged image update",
    /release-settlement-not-fleet-attached-unstarted \(record\.update\)/,
    (f) => rewriteSource(f, (record) => ({ ...record, update: stagedUpdate(f, record) })),
    { colors: ["blue", "green"], bound: ["blue", "green"], configured: true },
  ],
  [
    "a native row another instance created than the bootstrap declared",
    /release-settlement-not-fleet-attached-unstarted \(record\.bootstrap\)/,
    (f) =>
      rewriteSource(f, (record) => ({
        ...record,
        bootstrap: {
          blue: {
            ...record.bootstrap.blue!,
            declaration: { ...record.bootstrap.blue!.declaration, instanceId: "3".repeat(32) },
          },
        },
      })),
  ],
  [
    "a bootstrap whose create never reached native state",
    /release-settlement-not-fleet-attached-unstarted \(record\.bootstrap\)/,
    (f) =>
      rewriteSource(f, (record) => ({
        ...record,
        bootstrap: {
          ...record.bootstrap,
          green: bootstrapManifest({
            color: "green",
            source: f.sourceCandidate,
            accountId: f.accountId,
            rootApplicationId: "pool-app",
            epoch: 1,
          }),
        },
      })),
  ],
  [
    "a bootstrap another candidate journaled",
    /release-settlement-not-fleet-attached-unstarted \(record\.bootstrap\)/,
    (f) =>
      rewriteSource(f, (record) => ({
        ...record,
        bootstrap: {
          blue: bootstrapManifest({
            color: "blue",
            source: "9".repeat(40),
            accountId: f.accountId,
            rootApplicationId: "pool-app",
            epoch: 1,
          }),
        },
      })),
  ],
  [
    "a candidate staged on the live controller",
    /release-settlement-adopted-selection-unexpected \(selection\.candidate\)/,
    (f) =>
      (f.controller.firstInspect = (live) =>
        rewritten(live, (result) => {
          const selection = Schema.decodeUnknownSync(Fields)(result.selection);
          return { ...result, selection: { ...selection, candidate: selection.active } };
        })),
  ],
  [
    "a fenced active slot",
    /release-settlement-adopted-selection-unexpected \(selection\.fenced\)/,
    (f) =>
      (f.controller.firstInspect = (live) =>
        rewritten(live, (result) => {
          const selection = Schema.decodeUnknownSync(Fields)(result.selection);
          const active = Schema.decodeUnknownSync(Fields)(selection.active);
          return { ...result, selection: { ...selection, active: { ...active, fenced: true } } };
        })),
  ],
  [
    "a bootstrapped application with a running instance",
    /release-settlement-inactive-application-serving \(PoolRuntimeBlue\)/,
    (f) => f.serveFleet("pool-blue", 1),
  ],
  [
    "a fleet runtime running without any permission",
    /release-settlement-fleet-unexpected \(fleet\.resources\) observed=1$/,
    (f) => (f.controller.fleet = { ...f.controller.fleet, resources: [fleetRow(f)] }),
  ],
  [
    "a fleet runtime on another image input",
    /release-settlement-fleet-unexpected \(fleet\.resources\) observed=1$/,
    (f) => serving(f, fleetRow(f, { imageInput: "9".repeat(16) })),
    configured,
  ],
  [
    "a fleet runtime in an uncertain phase",
    /release-settlement-fleet-unexpected \(fleet\.resources\) observed=1$/,
    (f) => serving(f, fleetRow(f, { phase: "uncertain" })),
    configured,
  ],
  [
    "a fleet runtime on an application the permission never named",
    /release-settlement-fleet-unexpected \(fleet\.resources\) observed=1$/,
    (f) => serving(f, fleetRow(f, { applicationId: "pool-other" })),
    configured,
  ],
  [
    "a serving fleet instance on another image",
    /release-settlement-inactive-application-serving \(PoolRuntimeBlue\)/,
    (f) => {
      serving(f);
      f.serveFleetImage("pool-blue", `sha256:${"9".repeat(64)}`);
    },
    configured,
  ],
  [
    "a binding for a colour with no fleet application",
    /release-settlement-fleet-unexpected \(fleet\.binding\.green\)/,
    (f) =>
      (f.controller.fleet = {
        resources: [],
        bindings: [{ color: "green", applicationId: "pool-green", imageInput: "a".repeat(16) }],
      }),
  ],
  [
    "a binding to another application",
    /release-settlement-fleet-unexpected \(fleet\.binding\.blue\)/,
    (f) =>
      (f.controller.fleet = {
        resources: [],
        bindings: [{ color: "blue", applicationId: "pool-other", imageInput: "a".repeat(16) }],
      }),
  ],
  [
    "a live permission declaring other application pins",
    /release-settlement-fleet-unexpected \(fleet\.permission\.applications\)/,
    (f) =>
      livePermission(f, (configuration) => ({
        ...configuration,
        applications: configuration.applications.map((app) =>
          app.color === "green" ? { ...app, applicationVersion: "9" } : app,
        ),
      })),
    configured,
  ],
  [
    "a live permission whose legacy is not the selected root",
    /release-settlement-fleet-unexpected \(fleet\.permission\.legacy\)/,
    (f) =>
      livePermission(f, (configuration) => ({
        ...configuration,
        legacy: { ...configuration.legacy, bootId: "baseline-boot" },
      })),
    configured,
  ],
  [
    "a live permission under another controller code",
    /release-settlement-fleet-unexpected \(fleet\.permission\.controller\)/,
    (f) =>
      livePermission(f, (configuration) => ({
        ...configuration,
        controllerCode: { ...configuration.controllerCode, workerInput: "6".repeat(64) },
      })),
    configured,
  ],
  [
    "a live permission whose digest is not its configuration's",
    /release-settlement-fleet-unexpected \(fleet\.permission\.digest\)/,
    (f) =>
      livePermission(f, (configuration) => ({ ...configuration, maximum: 3 }), {
        staleDigest: true,
      }),
    configured,
  ],
  [
    "a live permission at the retained revision with other content",
    /release-settlement-fleet-unexpected \(fleet\.permission\.retained\)/,
    (f) => livePermission(f, (configuration) => ({ ...configuration, revision: 1, maximum: 3 })),
    configured,
  ],
  [
    // The next release would build green while the root is selected, and the fleet runs there.
    "a live permission naming the colour the next release builds as active",
    /release-settlement-fleet-unexpected \(fleet\.permission\.active\)/,
    (f) => livePermission(f, (configuration) => ({ ...configuration, active: "green" })),
    configured,
  ],
  [
    "a recovered permission whose sent fields drifted from the retained configuration",
    /release-settlement-fleet-unexpected \(fleet\.permission\.retained\)/,
    (f) => livePermission(f, (configuration) => ({ ...configuration, targetActive: 7 })),
    configured,
  ],
  [
    "a fleet runtime on the inactive colour",
    /release-settlement-fleet-unexpected \(fleet\.resources\) observed=1$/,
    (f) => serving(f, fleetRow(f, { color: "green" })),
    configured,
  ],
  [
    "a serving instance on the inactive colour's application",
    /release-settlement-inactive-application-serving \(PoolRuntimeGreen\)/,
    (f) => {
      serving(f);
      f.serveFleet("pool-green", 1);
    },
    configured,
  ],
  [
    "a retained configuration for another controller",
    /release-settlement-not-fleet-attached-unstarted \(record\.configurations\)/,
    (f) =>
      rewriteSource(f, (record) => ({
        ...record,
        configurations: Object.fromEntries(
          Object.entries(record.configurations).map(([key, value]) => [
            key,
            { ...value, controllerCode: { ...value.controllerCode, workerInput: "4".repeat(64) } },
          ]),
        ),
      })),
    { colors: ["blue", "green"], bound: ["blue", "green"], configured: true },
  ],
  [
    "a selection on another application than the bootstrap ran beside",
    /release-settlement-bootstrap-active-drift \(bootstrap\.blue\)/,
    (f) =>
      rewriteSource(f, (record) => ({
        ...record,
        bootstrap: {
          blue: {
            ...record.bootstrap.blue!,
            active: { ...record.bootstrap.blue!.active, applicationId: "pool-other" },
          },
        },
      })),
  ],
];
for (const [name, reason, change, shape] of refusals)
  test(`fleet-attached-unstarted settlement refuses ${name}`, async (context: TestContext) => {
    const f = await fleetAttachedFixture(context, shape);
    await change(f);
    await assert.rejects(plan(f), reason);
    assert.equal(f.writes(), 0);
  });

test("the earlier dispositions still refuse a fleet-attached source, and this one refuses a source without fleet applications", async (context) => {
  const f = await fleetAttachedFixture(context);
  await assert.rejects(
    planSettlement(f, "controller-active-adopted"),
    /release-settlement-not-controller-active \(record\.bootstrap\)/,
  );
  const plain = await controllerRecoveredFixture(context);
  await assert.rejects(
    planSettlement(plain, "fleet-attached-unstarted"),
    /release-settlement-not-fleet-attached-unstarted \(record\.baseline\.fleet\)/,
  );
  assert.equal(f.writes() + plain.writes(), 0);
});

test("preflight requires fleet-attached-unstarted only while nothing past the fleet is journaled", async (context) => {
  const f = await fleetAttachedFixture(context, configured);
  const prior = unsettledPrior(f.record);
  assert.deepEqual(prior, { candidate: f.sourceCandidate, fleetAttached: true });
  const verdict = (fleetAttached: boolean, rootSelected = true) =>
    settlementVerdict({
      prior: prior.candidate,
      liveCandidate: f.sourceCandidate,
      selected: true,
      fleetAttached,
      rootSelected,
    });
  assert.deepEqual(verdict(prior.fleetAttached), {
    disposition: "fleet-attached-unstarted",
    supported: true,
  });
  // A release that adopted an earlier candidate's applications bootstrapped nothing itself.
  const adopting: RuntimeReleaseRecord = { ...f.record, bootstrap: {} };
  assert.equal(unsettledPrior(adopting).fleetAttached, true);
  const startup = await promotion(f);
  // Each of these is past the fleet: plan refuses it, so preflight must not call it supported.
  for (const record of [
    { ...f.record, promotion: startup },
    { ...f.record, update: stagedUpdate(f, f.record) },
    { ...f.record, ...(await abortedStartup(f)) },
    { ...f.record, complete: true },
  ] satisfies RuntimeReleaseRecord[]) {
    const later = unsettledPrior(record);
    assert.equal(later.fleetAttached, false);
    assert.equal(verdict(later.fleetAttached).disposition, "controller-active-adopted");
  }
});

test("preflight reports a selected fleet primary as unsupported: the plan reads only a selected root", async (context) => {
  const f = await fleetAttachedFixture(context, configured);
  // A release stopped after its controller phase once a primary was promoted and the root retired.
  for (const fleetAttached of [true, false])
    assert.deepEqual(
      settlementVerdict({
        prior: f.sourceCandidate,
        liveCandidate: f.sourceCandidate,
        selected: true,
        fleetAttached,
        rootSelected: false,
      }),
      { disposition: "selected-fleet-primary", supported: false },
    );
  // The plan itself refuses that selection at the root read.
  f.controller.firstInspect = (live) =>
    rewritten(live, (result) => {
      const selection = Schema.decodeUnknownSync(Fields)(result.selection);
      const active = Schema.decodeUnknownSync(Fields)(selection.active);
      const target = Schema.decodeUnknownSync(Fields)(active.target);
      return {
        ...result,
        selection: {
          ...selection,
          active: { ...active, target: { ...target, slotId: "primary-x" } },
        },
      };
    });
  await assert.rejects(
    plan(f),
    /release-settlement-adopted-selection-unexpected \(selection\.target\)/,
  );
  assert.equal(f.writes(), 0);
});

const nextCandidate = {
  candidate: "c".repeat(40),
  code: { candidate: "c".repeat(40), workerInput: "4".repeat(64) },
};
const afterNext = "d".repeat(40);
/** Source X settled for real: its archive is what frees the candidate that adopts its fleet. */
const settleSource = async (f: SettlementFixture) => {
  await apply(f, await plan(f));
  assert.equal(f.writes(), 1);
};
for (const bootstrap of [[], ["green"]] as const)
  test(`a candidate that adopted the settled source's blue${bootstrap.length ? " and bootstrapped green" : ""}, then stopped after its controller phase, settles too`, async (context) => {
    const f = await fleetAttachedFixture(context);
    await settleSource(f);
    await adoptingRelease(f, { ...nextCandidate, bootstrap });
    // Its own record bootstrapped only what it created; its controller phase bound blue as well.
    await assert.rejects(
      planFrom(f, nextCandidate, afterNext, "controller-active-adopted"),
      bootstrap.length ? /\(record\.bootstrap\)/ : /release-settlement-fleet-present/,
    );
    const manifest = await planFrom(f, nextCandidate, afterNext);
    assert.ok(manifest.proof.disposition === "fleet-attached-unstarted");
    assert.deepEqual(manifest.proof.controllerReads.colors, ["blue", ...bootstrap]);
    assert.equal(manifest.proof.controllerReads.witness, "recovered-restart");
    assert.deepEqual(manifest.proof.controller.code, nextCandidate.code);
    const receipt = await applyFrom(f, manifest);
    assert.equal(receipt.stateWrites, 1);
    assert.equal(f.writes(), 2);
    const head = await (
      await Effect.runPromise(f.provide(runtimeReleaseJournal(f.scope, f.writer(afterNext), f.key)))
    ).head();
    assert.deepEqual(head.sourceController, nextCandidate.code);
  });

test("an adopting candidate whose root is still at adopt's epoch 1 stays refused: the witness is bound to the adopting controller", async (context) => {
  const f = await fleetAttachedFixture(context, { colors: ["blue"] }, { recovered: false });
  await settleSource(f);
  await adoptingRelease(f, nextCandidate);
  await assert.rejects(
    planFrom(f, nextCandidate, afterNext),
    /release-settlement-witness-unproven \(PoolWorker\.witness\.409\.slot_identity\)/,
  );
  assert.equal(f.writes(), 1);
});

test("a candidate that adopted a configured source's fleet, then stopped before its own configure, settles under the source's live permission", async (context) => {
  const f = await fleetAttachedFixture(context, configured);
  await settleSource(f);
  await adoptingRelease(f, nextCandidate);
  // The source's permission stays live; the adopting record retained no configuration of its own.
  const live = Schema.decodeUnknownSync(
    Schema.Struct({ permission: Schema.Struct({ operationId: Schema.String }) }),
    { onExcessProperty: "ignore" },
  )(f.controller.fleet).permission;
  assert.equal(live.operationId, `configure-${f.sourceCandidate}`);
  serving(f);
  const manifest = await planFrom(f, nextCandidate, afterNext);
  assert.ok(manifest.proof.disposition === "fleet-attached-unstarted");
  assert.equal(manifest.proof.controllerReads.permission, "present");
  assert.deepEqual(manifest.proof.controllerReads.colors, ["blue", "green"]);
  assert.equal((await applyFrom(f, manifest)).stateWrites, 1);
  assert.equal(f.writes(), 2);
});
