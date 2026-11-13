import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseWorkers } from "./barrier.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import { containerRelease } from "./test/container-fixture.ts";

test("all image and Worker admissions precede database work and every activation", async () => {
  const proof = containerRelease();
  const result = await releaseWorkers(proof.manifest, proof.options);
  assert.deepEqual(proof.events, [
    "image:verified",
    "admit:Api",
    "admit:PoolWorker",
    "admit:Router",
    "database",
    "image:verified",
    "activate:Api",
    "activate:PoolWorker",
    "activate:Router",
    "image:verified",
    "container:rollout",
    "container:advance",
    "container:adopted",
    "container:serving",
  ]);
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.containers, [
    { container: "PoolContainer", version: 2, rolloutId: "rollout", promoted: true },
  ]);
  assert.equal(result.phase, "complete");
});

test("new image inputs that publish the existing digest do not PATCH or roll out the same configuration", async () => {
  const proof = containerRelease();
  const container = {
    ...proof.frozen,
    imageDigest: proof.frozen.baseline.configuration.image.split("@")[1]!,
    configuration: proof.previous.configuration,
  };
  const result = await releaseWorkers(
    { ...proof.manifest, containers: [container] },
    {
      ...proof.options,
      sqlSchemas: async () => readySqlSchemas(proof.manifest.candidate, container.imageDigest),
    },
  );
  assert.ok(
    !proof.events.some((event) =>
      ["container:rollout", "container:advance", "container:adopted"].includes(event),
    ),
  );
  assert.equal(proof.events.filter((event) => event === "container:serving").length, 1);
  assert.deepEqual(result.containers, [
    { container: "PoolContainer", version: 1, unchanged: true },
  ]);
});

for (const failure of [
  "late-rejection",
  "missing-startup",
  "startup-over-750",
  "baseline-drift",
  "source-drift",
])
  test(`${failure} leaves every Worker and the container unchanged`, async () => {
    const proof = containerRelease();
    if (failure === "late-rejection")
      proof.options.provider.upload = async (worker) => {
        if (worker.id === "Router") throw new Error();
        return { versionId: worker.id, startupTimeMs: 100 };
      };
    if (failure === "missing-startup")
      proof.options.provider.upload = async () => ({ versionId: "accepted" });
    if (failure === "startup-over-750")
      proof.options.provider.upload = async () => ({ versionId: "accepted", startupTimeMs: 751 });
    if (failure === "baseline-drift") proof.setCurrent({ ...proof.current(), version: 99 });
    if (failure === "source-drift")
      proof.options.containers.verifySource = async () => {
        throw new Error();
      };
    await assert.rejects(releaseWorkers(proof.manifest, proof.options));
    assert.ok(
      !proof.events.some(
        (event) => event.startsWith("activate:") || event.startsWith("container:"),
      ),
    );
    assert.deepEqual(
      [...proof.active.values()],
      proof.manifest.workers.map((worker) => worker.baseline),
    );
  });

for (const phase of ["rollout", "advance", "verification"] as const)
  test(`a lost ${phase} response keeps the exact pending container intent`, async () => {
    const proof = containerRelease();
    const rollout = proof.options.containers.rollout;
    if (phase === "rollout") {
      proof.options.containers.rollout = async (container) => {
        await rollout(container);
        throw new Error("lost response");
      };
    } else if (phase === "advance") {
      proof.options.containers.advance = async () => {
        throw new Error("promotion response lost");
      };
    } else
      proof.options.containers.wait = async () => {
        throw new Error("observation lost");
      };
    await assert.rejects(releaseWorkers(proof.manifest, proof.options), /activation-unconfirmed/);
    const last = proof.receipts.at(-1)!;
    assert.deepEqual(last.pendingContainer, {
      container: "PoolContainer",
      phase,
      ...(phase !== "rollout" ? { version: 2, rolloutId: "rollout" } : {}),
    });
    assert.equal(last.activated.length, 3);
    assert.equal(last.containers?.length, phase !== "rollout" ? 1 : 0);
    assert.equal(proof.events.filter((event) => event === "container:rollout").length, 1);
  });

test("application drift during Worker activation refuses the container POST", async () => {
  const proof = containerRelease();
  const activate = proof.options.provider.activate;
  proof.options.provider.activate = async (worker, version) => {
    await activate(worker, version);
    if (worker.id === "Router") proof.setCurrent({ ...proof.current(), version: 99 });
  };
  await assert.rejects(releaseWorkers(proof.manifest, proof.options), /container-baseline-drift/);
  assert.ok(!proof.events.includes("container:rollout"));
});

for (const interrupted of ["Api", "PoolWorker", "Router"])
  test(`an interrupted ${interrupted} activation retains exact intent and never starts a container rollout`, async () => {
    const proof = containerRelease();
    const activate = proof.options.provider.activate;
    proof.options.provider.activate = async (worker, version) => {
      await activate(worker, version);
      if (worker.id === interrupted) throw new Error("response lost");
    };
    await assert.rejects(releaseWorkers(proof.manifest, proof.options), /activation-unconfirmed/);
    const receipt = proof.receipts.at(-1)!;
    assert.deepEqual(receipt.pending, { worker: interrupted, versionId: `new-${interrupted}` });
    assert.deepEqual(
      receipt.activated.map((item) => item.worker),
      ["Api", "PoolWorker", "Router"].slice(
        0,
        ["Api", "PoolWorker", "Router"].indexOf(interrupted),
      ),
    );
    assert.ok(!proof.events.includes("container:rollout"));
    assert.deepEqual(proof.current(), proof.previous);
  });
