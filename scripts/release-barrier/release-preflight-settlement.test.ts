// The preflight against an unsettled prior: the real preflightSteps, journal, settlement proof,
// read-only State, probe fetch and bridge guard. Only the state-store version read and the Node
// bridge (test/release-preflight-standins.ts) are stand-ins, plus the fixture's Cloudflare readers.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import {
  controllerActiveFixture,
  controllerRecoveredFixture,
  type SettlementFixture,
} from "./test/settlement-plan.ts";
import { next, stoppedBeforeForward } from "./test/settlement-before-forward.ts";
import { preflightReport, preflightSummary } from "./release-preflight-report.ts";
import { preflightRunner } from "./release-preflight.ts";
import {
  createPreflightBridgeCounters,
  readOnlyPoolOperations,
} from "./release-preflight-guard.ts";
import type { ControllerAttempt } from "./release-preflight-steps.ts";
import {
  countReadOnlyProbeFetch,
  countReadOnlyState,
  createRehearsalCounters,
} from "./release-resume-rehearsal.ts";
import { productionWorker, productionWorkerResponse } from "./test/production-worker-api.ts";
import { slotSelectionKey } from "../../src/pool/runtime-slots/storage.ts";
import { journalKey } from "./forward-journal.ts";
import { State } from "alchemy/State/State";
import { releaseSettlementFixture } from "./test/release-settlement-fixture.ts";
import { preflightSettlementProof } from "./release-preflight-settlement.ts";

const steps = new URL("./release-preflight-steps.ts", import.meta.url).href;
const standins = new URL("./test/release-preflight-standins.ts", import.meta.url).href;
const redirected = new Set(["./release-state-version.ts", "./release-preflight-guard.ts"]);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === steps && redirected.has(specifier))
      return { url: standins, shortCircuit: true };
    return next(specifier, context);
  },
});
const { preflightSteps } = await import("./release-preflight-steps.ts");
const standin = await import("./test/release-preflight-standins.ts");

/** One Check-mode preflight of `candidate`, every client read-only and counted as the entry's. */
async function preflight(
  context: TestContext,
  f: SettlementFixture,
  candidate: string,
  /** Controller codes earlier release receipts name, as the entry reads them. */
  receipts: (typeof f.code)[] = [],
) {
  assert.ok(f.io.connect);
  standin.installPoolOperations(f.io.connect);
  const counters = createRehearsalCounters();
  const production = (method: string, url: URL) =>
    productionWorkerResponse({ ...productionWorker({}), accountId: f.accountId }, method, url);
  const network = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const answer = production(request.method, url);
    if (answer && !url.pathname.endsWith("/deployments")) return answer;
    const worker = url.pathname.split("/").at(-2)!;
    if (!url.pathname.endsWith("/deployments") || !f.active.has(worker))
      throw new Error("No network in the offline preflight proof");
    return Response.json({
      success: true,
      result: {
        deployments: [
          {
            id: `deployment-${worker}`,
            created_on: "2026-01-01T00:00:00Z",
            versions: f.active
              .get(worker)!
              .map((row) => ({ version_id: row.versionId, percentage: row.percentage })),
          },
        ],
      },
    });
  };
  // The entry installs the guarded probe fetch globally; any non-GET is counted and blocked.
  // Records which State outputs the run read, by stack name.
  const outputs: string[] = [];
  const state: typeof f.state = {
    ...f.state,
    getOutput: (key) => {
      outputs.push(key.stack);
      return f.state.getOutput(key);
    },
  };
  const guarded = countReadOnlyProbeFetch(f.accountId, counters, network);
  context.mock.method(globalThis, "fetch", guarded);
  const runner = preflightRunner();
  const bridge = createPreflightBridgeCounters();
  const attempts: ControllerAttempt[] = [];
  await Effect.runPromise(
    f.provide(
      preflightSteps(f.compiled, {
        candidate,
        state: countReadOnlyState(state, counters),
        fetch: guarded,
        bridge,
        runner,
        credentials: { accountId: f.accountId, apiToken: "synthetic", encryptionKey: f.key },
        directory: f.io.directory,
        receipts,
        attempts,
        counters,
        settlementIo: {
          ...(f.io.container ? { container: f.io.container } : {}),
          ...(f.io.placement ? { placement: f.io.placement } : {}),
          ...(f.io.forward ? { forward: f.io.forward } : {}),
        },
      }),
    ),
  );
  const settlement = runner.results.find((row) => row.step === "release-settlement");
  const report = preflightReport({
    candidate,
    mode: "check",
    steps: runner.results,
    state: counters,
    bridge,
  });
  return {
    settlement,
    report,
    counters,
    bridge,
    attempts,
    outputs,
    summary: preflightSummary(report),
  };
}

test("the Check proves a release that stopped before its forward packet settles, read-only", async (context) => {
  const { f } = await stoppedBeforeForward(context);
  const writes = f.writes();
  const { settlement, report, counters, attempts, outputs, summary } = await preflight(
    context,
    f,
    next,
  );
  // The verdict reads the forward head's candidate, which still belongs to the frozen release.
  assert.ok(outputs.includes(journalKey(f.scope).stack));
  // The readiness row's code is refused; the code the prior's image record froze is accepted.
  assert.deepEqual(
    attempts.map(({ source, candidate, outcome }) => ({
      source,
      candidate,
      accepted: outcome === "accepted",
    })),
    [
      { source: "recorded", candidate: "0".repeat(40), accepted: false },
      { source: "prior-journal-record", candidate: f.code.candidate, accepted: true },
    ],
  );
  assert.ok(settlement?.status === "settlement-required", JSON.stringify(report.steps));
  // Not abandoned-before-controller: the forward head names another release than the prior.
  assert.equal(settlement.disposition, "abandoned-before-forward");
  const proof = settlement.proof;
  assert.ok(proof?.status === "accepted", JSON.stringify(proof));
  assert.equal(proof.source, f.candidate);
  assert.equal(proof.controller, f.code.candidate);
  // The proof's own reads: the signed handoff reads over the guarded bridge, and State reads only.
  assert.deepEqual(proof.reads.bridge, {
    inspect: 2,
    "active-health": 1,
    "fleet-inspect": 1,
    witness: 1,
  });
  assert.equal(proof.reads.state?.writeAttempts, 0);
  assert.ok(proof.reads.state!.getOutput > 0 && proof.reads.state!.get > 0);
  assert.equal(proof.reads.http?.blockedMutations, 0);
  assert.equal(counters.state.writeAttempts, 0);
  assert.equal(counters.fetch.blockedMutationAttempts, 0);
  assert.deepEqual(report.mutations.refusedBridgeRequests, {});
  assert.equal(f.writes(), writes);
  assert.match(
    summary,
    new RegExp(
      `- release-settlement: SETTLEMENT REQUIRED \\(abandoned-before-forward\\); blocks the release until applied; proof accepted for abandoned-before-forward, source ${f.candidate} \\[reads: State 25 get, 7 getOutput; 1 provider GET; bridge inspect 2, active-health 1, fleet-inspect 1, witness 1\\]`,
      "u",
    ),
  );
});

test("a refused settlement proof surfaces its own refusal and fails the Check", async (context) => {
  const { f } = await stoppedBeforeForward(context);
  // The live-controller inspect is the first; the selection is gone when the proof reads it.
  f.controller.finalInspect = async (live) => {
    f.controller.storage.values.delete(slotSelectionKey);
    return live();
  };
  const { settlement, report, counters, summary } = await preflight(context, f, next);
  assert.ok(settlement?.status === "settlement-required", JSON.stringify(report.steps));
  const proof = settlement.proof;
  assert.ok(proof?.status === "refused", JSON.stringify(proof));
  assert.deepEqual(proof.refusal, {
    reason: "release-settlement-adopted-selection-unexpected",
    field: "selection.absent",
  });
  assert.equal(report.status, "refused");
  assert.equal(counters.state.writeAttempts, 0);
  assert.equal(counters.fetch.blockedMutationAttempts, 0);
  assert.match(
    summary,
    /proof REFUSED for abandoned-before-forward, source c{40}: release-settlement-adopted-selection-unexpected \(selection\.absent\)/u,
  );
});

// The controller-active dispositions are proven the same way through the real preflightSteps.
for (const [disposition, build] of [
  ["controller-active-unadopted", controllerActiveFixture],
  ["controller-active-adopted", controllerRecoveredFixture],
] as const)
  test(`the Check proves a ${disposition} prior read-only`, async (context) => {
    const f = await build(context);
    // The preflight's own inspect and fleet reads need the stand-in's real handoff answers.
    f.controller.realReads = true;
    // The source's own provider-observation receipt names the code its controller phase installed.
    const { settlement, report, counters } = await preflight(context, f, f.candidate, [f.code]);
    assert.ok(settlement?.status === "settlement-required", JSON.stringify(report.steps));
    assert.equal(settlement.disposition, disposition);
    assert.ok(settlement.proof?.status === "accepted", JSON.stringify(settlement.proof));
    assert.equal(settlement.proof.source, f.sourceCandidate);
    assert.equal(counters.state.writeAttempts, 0);
    assert.equal(counters.fetch.blockedMutationAttempts, 0);
    assert.deepEqual(report.mutations.refusedBridgeRequests, {});
  });

// An abandoned-before-controller verdict needs a live controller older than its source, which the
// stand-in controller cannot run, so the same proof call runs on the same read-only clients here.
test("the Check's proof of an abandoned-before-controller prior runs read-only", async (context) => {
  const f = await releaseSettlementFixture(context, {});
  assert.ok(f.io.connect);
  const counters = createRehearsalCounters();
  const bridge = createPreflightBridgeCounters();
  context.mock.method(
    globalThis,
    "fetch",
    countReadOnlyProbeFetch(f.accountId, counters, async () => {
      throw new Error("No network in the offline preflight proof");
    }),
  );
  const state = countReadOnlyState(f.state, counters);
  const writes = f.writes();
  const proof = await preflightSettlementProof({
    compiled: f.compiled,
    state,
    // As the preflight's own read: the compiled stack's services, with the read-only State.
    read: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromise(
        f.provide(Effect.provideService(effect, State, Effect.succeed(state))) as Effect.Effect<
          A,
          E
        >,
      ),
    candidate: f.candidate,
    prior: f.sourceCandidate,
    disposition: "abandoned-before-controller",
    liveCode: f.code,
    accountId: f.accountId,
    encryptionKey: f.key,
    directory: f.io.directory,
    connect: readOnlyPoolOperations(f.io.connect, f.record.baseline.deploymentKey, bridge),
    bridge,
    counters,
    io: {
      ...(f.io.container ? { container: f.io.container } : {}),
      ...(f.io.placement ? { placement: f.io.placement } : {}),
      ...(f.io.forward ? { forward: f.io.forward } : {}),
    },
  });
  assert.ok(proof.status === "accepted", JSON.stringify(proof));
  assert.equal(proof.source, f.sourceCandidate);
  assert.deepEqual(proof.reads.bridge, { inspect: 1, "recovery-health": 1 });
  assert.deepEqual(bridge.refused, {});
  assert.equal(counters.state.writeAttempts, 0);
  assert.equal(counters.fetch.blockedMutationAttempts, 0);
  assert.equal(f.writes(), writes);
});
