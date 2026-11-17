import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import type { StateService } from "alchemy/State/State";
import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { baselineControllerHealth, type BaselineController } from "./baseline-controller.ts";
import { ReleaseSettlementProof, releaseImageJournalKey } from "./release-settlement-contract.ts";
import {
  countBaselineReadDeclaration,
  countReadOnlyBaselineConnect,
  countReadOnlyProbeFetch,
  countReadOnlyState,
  createRehearsalCounters,
} from "./release-resume-rehearsal.ts";
import {
  assertNotApplicableRehearsalReadOnly,
  assertReadOnlyRehearsal,
  releaseRehearsalNotApplicableReceipt,
  releaseRehearsalReceipt,
} from "./release-resume-rehearsal-receipt.ts";
import { journalKey, writeForwardJournal } from "./forward-journal.ts";
import { runtimeReleaseJournal } from "./runtime-release-journal.ts";
import { releaseSettlementFixture } from "./test/release-settlement-fixture.ts";
import { inspectReleaseRehearsalSource } from "./release-resume-rehearsal-source.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";

const accountId = "a".repeat(32);
const key = "b".repeat(64);
const baseline: BaselineController = {
  code: { candidate: "c".repeat(40), workerInput: "d".repeat(64) },
  target: { worker: "private-worker-fixture", accountId },
  imageHash: "e".repeat(64),
  versions: [{ versionId: "private-version-fixture", percentage: 100 }],
  workerDigest: "f".repeat(64),
  readinessDigest: "0".repeat(64),
};

function settlementProof(): typeof ReleaseSettlementProof.Type {
  return Schema.decodeUnknownSync(ReleaseSettlementProof)({
    disposition: "abandoned-before-controller",
    controller: baseline,
    health: { instanceId: "private-instance-fixture", bootId: "private-boot-fixture" },
    imageBaselineDigest: "1".repeat(64),
    nativeBeforeDigest: "2".repeat(64),
    nativeAfterDigest: "2".repeat(64),
    nativeResources: [{ fqn: "PoolWorker", digest: "3".repeat(64) }],
    workers: [
      {
        worker: "PoolWorker",
        target: "4".repeat(64),
        baseline: [{ versionId: "private-version-fixture", percentage: 100 }],
        active: [{ versionId: "private-version-fixture", percentage: 100 }],
        accepted: null,
        placements: [{ versionId: "private-version-fixture", digest: "5".repeat(64) }],
      },
    ],
    applications: [{ resource: "PoolContainer", digest: "6".repeat(64) }],
    forwardManifest: "7".repeat(64),
    forwardProofDigest: "8".repeat(64),
    stateWrites: 0,
    runtimeMutations: 0,
  });
}

test("fetch guard counts provider and State GETs, labels edge-preview auth POSTs, and blocks writes", async () => {
  const counters = createRehearsalCounters();
  const dispatched: string[] = [];
  const guarded = countReadOnlyProbeFetch(accountId, counters, async (request) => {
    const value = new Request(request);
    dispatched.push(`${value.method} ${new URL(value.url).pathname}`);
    return new Response("{}", { status: 200 });
  });
  await guarded("https://state.example/version");
  await guarded("https://state.example/state/stacks");
  await guarded("https://state.example/state/stacks/basalt/stages/production/PoolWorker");
  await guarded(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/PoolWorker`,
  );
  await guarded(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain/edge-preview`,
    {
      method: "POST",
      body: "{}",
    },
  );
  await assert.rejects(
    guarded(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/PoolWorker/versions`,
      {
        method: "POST",
        body: "{}",
      },
    ),
    /mutation-refused/,
  );
  assert.equal(counters.fetch.stateGetAttempts, 3);
  assert.equal(counters.fetch.stateGetCompleted, 3);
  assert.equal(counters.fetch.providerGetAttempts, 1);
  assert.equal(counters.fetch.providerGetCompleted, 1);
  assert.equal(counters.fetch.edgePreviewAuthPosts, 1);
  assert.equal(counters.fetch.edgePreviewAuthCompleted, 1);
  assert.equal(counters.fetch.blockedMutationAttempts, 1);
  assert.equal(dispatched.length, 5);
});

test("State reads are counted and State mutation methods refuse before the backing store", async () => {
  const counters = createRehearsalCounters();
  const backing: StateService = {
    id: "fixture",
    getVersion: () => Effect.succeed(8),
    listStacks: () => Effect.succeed(["basalt"]),
    listStages: () => Effect.succeed(["production"]),
    get: () => Effect.succeed(undefined),
    getReplacedResources: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    getOutput: () => Effect.succeed(undefined),
    set: (request) => Effect.succeed(request.value),
    delete: () => Effect.succeed(undefined),
    deleteStack: () => Effect.succeed(undefined),
    setOutput: (request) => Effect.succeed(request.value),
  };
  const state = countReadOnlyState(backing, counters);
  await Effect.runPromise(state.getVersion());
  await Effect.runPromise(state.get({ stack: "basalt", stage: "production", fqn: "PoolWorker" }));
  await Effect.runPromise(state.getOutput({ stack: "basalt", stage: "production" }));
  await assert.rejects(
    Effect.runPromise(state.delete({ stack: "basalt", stage: "production", fqn: "PoolWorker" })),
    /write-refused/,
  );
  assert.deepEqual(
    {
      version: counters.state.getVersion,
      get: counters.state.get,
      output: counters.state.getOutput,
    },
    { version: 1, get: 1, output: 1 },
  );
  assert.equal(counters.state.writeAttempts, 1);
});

test("b99 rehearsal dispatches only baseline inspect and recovery health reads", async () => {
  const counters = createRehearsalCounters();
  const dispatched: string[] = [];
  let wrongIdentity = false;
  const baseConnect: NonNullable<PoolOperationsTarget["connect"]> = async () => ({
    env: {
      POOL_OPERATIONS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          dispatched.push(`${request.method} ${url.pathname}`);
          if (request.method === "POST" && url.pathname === runtimeHandoffPath)
            return Response.json({
              result: {
                controllerCode: wrongIdentity
                  ? { ...baseline.code, candidate: "0".repeat(40) }
                  : baseline.code,
              },
            });
          if (request.method === "GET" && url.pathname === runtimeRecoveryPath)
            return Response.json({
              instanceId: "9".repeat(64),
              imageHash: baseline.imageHash,
              release: baseline.code.candidate,
              running: true,
              ready: true,
              bootId: "fixture-boot",
            });
          throw new Error("Unexpected fixture route");
        },
      },
    },
    dispose: async () => {},
  });
  const connect = countReadOnlyBaselineConnect(baseConnect, {
    expectedControllerCode: baseline.code,
    key,
    counters,
  });
  const health = await baselineControllerHealth({
    baseline,
    key,
    target: { ...baseline.target, connect },
    record: countBaselineReadDeclaration(counters),
  });
  assert.equal(health.instanceId, "9".repeat(64));
  assert.deepEqual(dispatched, [`POST ${runtimeHandoffPath}`, `GET ${runtimeRecoveryPath}`]);
  assert.deepEqual(
    {
      inspect: counters.runtime.inspectPostDispatches,
      health: counters.runtime.healthGetDispatches,
      declaredInspect: counters.runtime.declaredInspectReads,
      declaredHealth: counters.runtime.declaredHealthReads,
    },
    { inspect: 1, health: 1, declaredInspect: 1, declaredHealth: 1 },
  );
  const proof = settlementProof();
  assertReadOnlyRehearsal(proof, counters);
  const receipt = releaseRehearsalReceipt({
    candidate: "1".repeat(40),
    sourceCandidate: baseline.code.candidate,
    proof,
    counters,
    observedAt: "2026-11-17T00:00:00.000Z",
  });
  const encoded = JSON.stringify(receipt);
  for (const privateValue of [
    accountId,
    baseline.target.worker,
    "private-version-fixture",
    "private-instance-fixture",
    "private-boot-fixture",
  ])
    assert.ok(!encoded.includes(privateValue), privateValue);
  assert.match(encoded, /"infrastructure":0/);
  assert.match(encoded, /"runtime":0/);
  assert.match(encoded, /"edgePreviewPostsAreAuthenticationSessions":true/);
  assert.match(
    encoded,
    /Wrangler Node bridge startup, authentication and remote-binding internals/,
  );

  wrongIdentity = true;
  const before = dispatched.length;
  await assert.rejects(
    baselineControllerHealth({
      baseline,
      key,
      target: { ...baseline.target, connect },
    }),
    /provisioning-input-drift/,
  );
  assert.equal(dispatched.length, before + 1);
  assert.equal(counters.runtime.healthGetDispatches, 1);
});

test("unfinished matching heads use the live rehearsal path; a missing peer is not skipped", async (context) => {
  const f = await releaseSettlementFixture(context);
  const pending = await Effect.runPromise(inspectReleaseRehearsalSource(f.state, f.scope, f.key));
  assert.equal(pending.disposition, "pending");
  assert.equal(pending.sourceCandidate, f.sourceCandidate);

  await Effect.runPromise(
    f.state.deleteStack({ stack: journalKey(f.scope).stack, stage: f.scope.stage }),
  );
  await assert.rejects(
    Effect.runPromise(inspectReleaseRehearsalSource(f.state, f.scope, f.key)),
    /source-pair-incomplete/,
  );
  assert.equal(
    (await Effect.runPromise(f.state.getOutput(releaseImageJournalKey(f.scope)))) !== undefined,
    true,
  );
});

test("both authenticated absent heads produce not-applicable", async (context) => {
  const empty = await releaseSettlementFixture(context);
  await Effect.runPromise(
    empty.state.deleteStack({
      stack: releaseImageJournalKey(empty.scope).stack,
      stage: empty.scope.stage,
    }),
  );
  await Effect.runPromise(
    empty.state.deleteStack({ stack: journalKey(empty.scope).stack, stage: empty.scope.stage }),
  );
  const absent = await Effect.runPromise(
    inspectReleaseRehearsalSource(empty.state, empty.scope, empty.key),
  );
  assert.equal(absent.disposition, "not-applicable");
  assert.equal(absent.reason, "no-release-heads");
  assert.deepEqual([absent.image.state, absent.forward.state], ["absent", "absent"]);
  const counters = createRehearsalCounters();
  assertNotApplicableRehearsalReadOnly(counters);
  const receipt = releaseRehearsalNotApplicableReceipt({
    candidate: "9".repeat(40),
    reason: absent.reason,
    heads: {
      image: { state: absent.image.state, digest: absent.image.digest },
      forward: { state: absent.forward.state, digest: absent.forward.digest },
    },
    counters,
  });
  assert.equal(receipt.status, "not-applicable");
  assert.equal(receipt.authenticatedHeadReadback, true);
  assert.deepEqual(receipt.mutations, {
    state: 0,
    infrastructure: 0,
    runtime: 0,
    deniedStateWriteAttempts: 0,
    blockedHttpMutationAttempts: 0,
    refusedRuntimeCommands: 0,
    refusedRuntimeRequests: 0,
  });
});

test("both authenticated terminal heads produce not-applicable", async (context) => {
  const completed = await releaseSettlementFixture(context);
  const journal = await Effect.runPromise(
    completed.provide(
      runtimeReleaseJournal(
        completed.scope,
        completed.writer(completed.sourceCandidate),
        completed.key,
      ),
    ),
  );
  await journal.write({ ...completed.record, complete: true });
  await Effect.runPromise(
    writeForwardJournal(completed.state, completed.scope, completed.key, completed.packet, true),
  );
  const terminal = await Effect.runPromise(
    inspectReleaseRehearsalSource(completed.state, completed.scope, completed.key),
  );
  assert.equal(terminal.disposition, "not-applicable");
  assert.equal(terminal.reason, "release-heads-terminal");
  assert.deepEqual([terminal.image.state, terminal.forward.state], ["complete", "complete"]);
});

test("runtime bridge refuses unsupported and candidate-identity commands before dispatch", async () => {
  const counters = createRehearsalCounters();
  let delegated = 0;
  const connect = countReadOnlyBaselineConnect(
    async () => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async () => {
            delegated++;
            return new Response();
          },
        },
      },
      dispose: async () => {},
    }),
    { expectedControllerCode: baseline.code, key, counters },
  );
  const bridge = await connect("fixture-config");
  const call = async (action: string, controllerCode = baseline.code) => {
    const envelope = await signEnvelope(key, runtimeHandoffCommandPrefix, {
      action,
      controllerCode,
      at: 10,
      expiresAt: 20,
    });
    return bridge.env.POOL_OPERATIONS.fetch(
      new Request(`http://pool-operations${runtimeHandoffPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope }),
      }),
    );
  };
  await assert.rejects(call("active-health"), /command-refused/);
  await assert.rejects(
    call("inspect", { ...baseline.code, candidate: "0".repeat(40) }),
    /identity-refused/,
  );
  assert.equal(delegated, 0);
  assert.equal(counters.runtime.inspectPostDispatches, 0);
  assert.equal(counters.runtime.refusedNonInspectCommands, 1);
  assert.equal(counters.runtime.refusedOtherRequests, 1);
});
