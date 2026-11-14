import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { Effect, Redacted } from "effect";
import { containerPublication } from "./test/container-fixture.ts";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { runtimeReleaseState, runtimeApplicationPins } from "./runtime-release-state.ts";
import { runtimeReleaseJournal, type RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { ordinaryReleaseWriter } from "./runtime-release-writer.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";

const scope = { name: "synthetic", stage: "production" };
const candidate = "a".repeat(40),
  key = "b".repeat(64),
  accountId = "1".repeat(32);
const writer = (sha = candidate) =>
  ordinaryReleaseWriter({
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_JOB: "deploy",
    GITHUB_REPOSITORY: "JustYannicc/basalt",
    GITHUB_WORKFLOW_REF: "JustYannicc/basalt/.github/workflows/deploy.yml@refs/heads/main",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    BASALT_RELEASE_CANDIDATE: sha,
    ALCHEMY_STAGE: "production",
  });

async function fixture() {
  const state = await Effect.runPromise(InMemoryService());
  const put = (
    fqn: string,
    resourceType: string,
    props: Record<string, unknown>,
    attr: Record<string, unknown>,
  ) =>
    Effect.runPromise(
      state.set({
        stack: scope.name,
        stage: scope.stage,
        fqn,
        value: {
          resourceType,
          fqn,
          logicalId: fqn,
          namespace: undefined,
          instanceId: "2".repeat(32),
          providerVersion: 0,
          status: "created",
          downstream: [],
          bindings: [],
          props,
          attr,
        },
      }),
    );
  await put(
    "PoolWorker",
    "Cloudflare.Worker",
    {
      env: {
        POOL_DATABASE_URL: Redacted.make("postgresql://synthetic-secret@database.invalid/pool"),
        POOL_MANAGEMENT_KEY: Redacted.make("synthetic-management-secret"),
        POOL_APP_SIGNING_KEY: Redacted.make(key),
        POOL_DEPLOYMENT_KEY: Redacted.make(key),
        POOL_IMAGE_HASH: "3".repeat(16),
      },
    },
    { accountId, workerName: "synthetic-worker" },
  );
  for (const [index, resource] of [
    "PoolContainer",
    "PoolRuntime",
    "PoolRuntimeBlue",
    "PoolRuntimeGreen",
  ].entries()) {
    const base = containerPublication().previous;
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    await put(
      resource,
      "Cloudflare.Container",
      { retained: resource },
      {
        ...base,
        accountId,
        applicationId: `native-${resource}`,
        version: index + 7,
        configuration: {
          ...base.configuration,
          image: `registry.cloudflare.com/${accountId}/pool@${digest}`,
        },
        maxInstances: index < 2 ? 1 : 4,
        durableObjects: { namespaceId: `native-namespace-${resource}` },
        hash: { image: String(index + 3).repeat(16), digest },
      },
    );
  }
  const run = <A, E>(effect: Effect.Effect<A, E, State>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(State, Effect.succeed(state))));
  const baseline = await run(runtimeReleaseState(scope));
  const record: RuntimeReleaseRecord = {
    format: "pool-image-release-v1",
    candidate,
    complete: false,
    baseline,
    desiredInput: "8".repeat(16),
    desiredConfiguration: { ...baseline.configuration, managementKey: "synthetic-future-secret" },
    bootstrap: { blue: provisioningFixture("PoolRuntimeBlue").manifest },
    configurations: {},
  };
  return { state, run, baseline, record };
}

test("native State retains Root, the old single-runtime application, and both independently pinned fleet applications", async () => {
  const f = await fixture();
  assert.equal(f.baseline.configuration.managementKey, "synthetic-management-secret");
  for (const [color, resource] of [
    ["root", "PoolContainer"],
    ["legacy", "PoolRuntime"],
    ["blue", "PoolRuntimeBlue"],
    ["green", "PoolRuntimeGreen"],
  ] as const) {
    const retained = f.baseline.applications[color]!;
    assert.equal(retained.image.applicationId, `native-${resource}`);
    assert.equal(retained.attributes.durableObjects.namespaceId, `native-namespace-${resource}`);
    const pins = runtimeApplicationPins(retained.attributes, retained.image.inputHash);
    assert.equal(pins.applicationVersion, String(retained.attributes.version));
    assert.equal(pins.imageDigest, retained.image.digest);
    assert.equal(pins.imageInput, retained.image.inputHash);
    assert.equal(pins.accountId, accountId);
    assert.equal(pins.applicationConfigDigest.length, 64);
  }
});

test("the encrypted image journal restores exact settings and bootstrap intent, blocks unfinished foreign candidates, and authenticates readback", async () => {
  const f = await fixture();
  const journal = await f.run(runtimeReleaseJournal(scope, writer(), key));
  assert.equal(await journal.read(), undefined);
  const startup = (await runtimeProofFixture()).manifest;
  const record = {
    ...f.record,
    promotion: {
      operationId: startup.operationId,
      pool: "synthetic-pool",
      generation: 1,
      probeSent: true,
      promotionSent: true,
      startup,
    },
  };
  await journal.write(record);
  const storageKey = { stack: `${scope.name}-runtime-image-release`, stage: scope.stage };
  const saved = await Effect.runPromise(f.state.getOutput(storageKey));
  assert.ok(!JSON.stringify(saved).includes("synthetic-management-secret"));
  assert.ok(!JSON.stringify(saved).includes("synthetic-future-secret"));
  const reconstructed = await f.run(runtimeReleaseJournal(scope, writer(), key));
  assert.deepEqual(await reconstructed.read(), JSON.parse(JSON.stringify(record)));
  const foreign = await f.run(runtimeReleaseJournal(scope, writer("c".repeat(40)), key));
  await assert.rejects(foreign.read(), /prior-candidate-unsettled/);
  const wrongKey = await f.run(runtimeReleaseJournal(scope, writer(), "d".repeat(64)));
  await assert.rejects(wrongKey.read(), /authentication-failed/);
  await journal.write({ ...record, complete: true });
  assert.equal(await foreign.read(), undefined);
  await Effect.runPromise(
    f.state.setOutput({
      ...storageKey,
      value: { candidate, fingerprint: "f".repeat(64), sealed: {} },
    }),
  );
  await assert.rejects(reconstructed.read(), /authentication-failed/);
});

test("a confirmed startup abort settles the encrypted failed-candidate journal and preserves its terminal receipt", async () => {
  const f = await fixture();
  const proof = await runtimeProofFixture();
  const startup = proof.manifest;
  const journal = await f.run(runtimeReleaseJournal(scope, writer(), key));
  const record = {
    ...f.record,
    promotion: {
      operationId: startup.operationId,
      pool: "synthetic-pool",
      generation: 0,
      startup,
    },
  };
  await journal.write(record);
  const foreign = await f.run(runtimeReleaseJournal(scope, writer("c".repeat(40)), key));
  await assert.rejects(foreign.read(), /prior-candidate-unsettled/);
  const abort = {
    intent: {
      operationId: "operator-abort",
      target: startup.target,
      witness: proof.witness,
      startupOperationId: startup.operationId,
      expectedEpoch: startup.selection.expectedEpoch,
      active: startup.selection.active!,
    },
    status: "aborted" as const,
    sent: true,
  };
  await journal.write({ ...record, abort: { ...abort, status: "pending" } });
  await assert.rejects(foreign.read(), /prior-candidate-unsettled/);
  await journal.write({ ...record, abort });
  assert.equal(await foreign.read(), undefined);
  const retained = await Effect.runPromise(
    f.state.getOutput({
      stack: `${scope.name}-runtime-image-release-history-${candidate}`,
      stage: scope.stage,
    }),
  );
  assert.ok(retained);
  assert.ok(!JSON.stringify(retained).includes("synthetic-management-secret"));
  assert.deepEqual((await journal.read())?.abort, abort);
});
