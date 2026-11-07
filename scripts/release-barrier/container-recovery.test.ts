import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseWorkers } from "./barrier.ts";
import { containerRelease } from "./test/container-fixture.ts";
import { recoverWorkers, type RecoveryReceipt, type RecoveryProvider } from "./recovery.ts";
import { recoverContainers, type ContainerRecoveryOptions } from "./container-recovery.ts";

async function fixture() {
  const proof = containerRelease();
  const admitted = await releaseWorkers(proof.manifest, proof.options);
  proof.events.length = 0;
  const progress: RecoveryReceipt[] = [];
  const workers: RecoveryProvider = {
    async read(worker) {
      return { target: worker.target, versions: proof.active.get(worker.id)! };
    },
    async restore(worker) {
      proof.events.push(`restore:${worker.id}`);
      proof.active.set(worker.id, worker.baseline);
    },
  };
  const options: ContainerRecoveryOptions = {
    frozen: proof.manifest,
    databaseCompatible: true,
    provider: {
      async read() {
        return proof.current();
      },
      async rollout() {
        proof.events.push("restore:rollout");
        const currentVersion = proof.current().version;
        proof.setCurrent({ ...proof.previous, version: currentVersion + 1 });
        return { id: "recovery-rollout", currentVersion, targetVersion: currentVersion + 1 };
      },
      async wait(container, rollout, restored) {
        const current = proof.current();
        assert.equal(current.version, rollout.targetVersion);
        assert.deepEqual(
          current.configuration,
          restored ? container.baseline.configuration : container.configuration,
        );
        assert.equal(current.activeRolloutId, undefined);
        return current;
      },
      async verify() {
        proof.events.push("verify:all-old-instances");
        return { instanceId: "a".repeat(64), bootId: "old-boot", checkedAt: 123 };
      },
    },
  };
  const run = () =>
    recoverWorkers(
      proof.description,
      admitted,
      workers,
      async (value) => {
        progress.push(structuredClone(value));
      },
      (manifest, receipt, value, save) =>
        recoverContainers(manifest, receipt, options, value, save),
      options.previous,
    );
  return { ...proof, options, admitted, progress, workers, run };
}

test("recovery verifies every saved container image before restoring Worker baseline IDs", async () => {
  const proof = await fixture();
  const result = await proof.run();
  assert.deepEqual(proof.events, [
    "restore:rollout",
    "verify:all-old-instances",
    "restore:Router",
    "restore:PoolWorker",
    "restore:Api",
  ]);
  assert.deepEqual(result.containers, [
    {
      container: "PoolContainer",
      version: 3,
      rolloutId: "recovery-rollout",
      verified: true,
      health: { instanceId: "a".repeat(64), bootId: "old-boot", checkedAt: 123 },
    },
  ]);
  assert.deepEqual(proof.current().configuration, proof.previous.configuration);
  assert.equal(proof.current().instances, 1);
  proof.options.previous = result;
  proof.events.length = 0;
  await proof.run();
  assert.deepEqual(proof.events, ["verify:all-old-instances"]);
});

for (const refusal of [
  "foreign-worker",
  "foreign-container-version",
  "foreign-container-config",
  "database-unknown",
  "private-manifest-drift",
])
  test(`${refusal} refuses before the first container or Worker recovery write`, async () => {
    const proof = await fixture();
    if (refusal === "foreign-worker")
      proof.active.set("Router", [{ versionId: "foreign", percentage: 100 }]);
    if (refusal === "foreign-container-version")
      proof.setCurrent({ ...proof.current(), version: 99 });
    if (refusal === "foreign-container-config")
      proof.setCurrent({
        ...proof.current(),
        configuration: { ...proof.current().configuration, command: ["foreign"] },
      });
    if (refusal === "database-unknown") proof.options.databaseCompatible = false;
    if (refusal === "private-manifest-drift")
      proof.options.frozen = { ...proof.manifest, containers: [] };
    await assert.rejects(proof.run());
    assert.deepEqual(proof.events, []);
  });

test("a lost original rollout response cannot attribute a new application version by matching bytes", async () => {
  const proof = await fixture();
  proof.admitted.containers = [];
  proof.admitted.pendingContainer = { container: "PoolContainer", phase: "rollout" };
  await assert.rejects(proof.run(), /container-recovery-version-unconfirmed/);
  assert.deepEqual(proof.events, []);
});

test("a lost recovery rollout response retains intent and is never blindly repeated", async () => {
  const proof = await fixture();
  const rollout = proof.options.provider.rollout;
  proof.options.provider.rollout = async (container) => {
    await rollout(container);
    throw new Error("response lost");
  };
  await assert.rejects(proof.run(), /recovery-unconfirmed/);
  assert.deepEqual(proof.progress.at(-1)?.pendingContainer, {
    container: "PoolContainer",
    phase: "rollout",
  });
  proof.options.previous = proof.progress.at(-1);
  await assert.rejects(proof.run(), /container-recovery-version-unconfirmed/);
  assert.deepEqual(proof.events, ["restore:rollout"]);
});

test("an interrupted known recovery rollout is observed without another POST", async () => {
  const proof = await fixture();
  const wait = proof.options.provider.wait;
  proof.options.provider.wait = async (container, rollout, restored) => {
    if (restored) throw new Error("observation lost");
    return wait(container, rollout, restored);
  };
  await assert.rejects(proof.run(), /recovery-unconfirmed/);
  assert.equal(proof.progress.at(-1)?.pendingContainer?.phase, "verification");
  proof.options.previous = proof.progress.at(-1);
  proof.options.provider.wait = wait;
  await proof.run();
  assert.deepEqual(proof.events, [
    "restore:rollout",
    "verify:all-old-instances",
    "restore:Router",
    "restore:PoolWorker",
    "restore:Api",
  ]);
});

test("an active old-image or unhealthy instance prevents every Worker restoration", async () => {
  const proof = await fixture();
  proof.options.provider.verify = async () => {
    throw new Error("candidate instance still running");
  };
  await assert.rejects(proof.run(), /recovery-unconfirmed/);
  assert.ok(
    !proof.events.some(
      (event) =>
        event.startsWith("restore:Api") ||
        event.startsWith("restore:PoolWorker") ||
        event.startsWith("restore:Router"),
    ),
  );
  assert.equal(proof.progress.at(-1)?.pendingContainer?.phase, "verification");
});

test("Worker-only recovery cannot silently ignore a container manifest", async () => {
  const proof = await fixture();
  await assert.rejects(
    recoverWorkers(proof.description, proof.admitted, proof.workers, async () => {}),
    /container-recovery-required/,
  );
  assert.deepEqual(proof.events, []);
});

test("a later Worker preflight failure cannot erase an uncertain container recovery write", async () => {
  const proof = await fixture();
  proof.options.provider.rollout = async () => {
    throw new Error("response lost");
  };
  await assert.rejects(proof.run());
  const pending = proof.progress.at(-1)!;
  proof.options.previous = pending;
  proof.active.set("Router", [{ versionId: "foreign", percentage: 100 }]);
  await assert.rejects(proof.run(), /recovery-deployment-drift/);
  assert.deepEqual(proof.progress.at(-1)?.pendingContainer, pending.pendingContainer);
  assert.deepEqual(proof.progress.at(-1)?.containers, pending.containers);
});
