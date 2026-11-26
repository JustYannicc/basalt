import assert from "node:assert/strict";
import { test } from "node:test";
import { poolRuntimeFleetFixture } from "../../scripts/pool-tests/pool-runtime-fleet-fixture.ts";
import type { ControllerCode } from "./runtime-slots/contract.ts";

// #1802: a Worker deploy changes the controller code. A permission the signed command committed
// under the last code must stay in force under the next one; only the commit checks the code.
const before: ControllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
const after: ControllerCode = { candidate: "e".repeat(40), workerInput: "f".repeat(64) };

const fixture = () => poolRuntimeFleetFixture(before);

test("a permission committed under the last code launches and inspects in force under the next", async () => {
  const f = await fixture();
  await f.worker(before).configure("enable", f.configuration);
  const deployed = f.worker(after);
  // Growth's own target and the reservation's permission, as a launch under the next code runs them.
  const target = await deployed["target"]([]);
  await deployed.state.reserve(target);
  assert.equal((await deployed.state.inspect()).length, 1, "the launch reserved its row");
  const view = await deployed.inspect();
  assert.equal(view.inForce, true);
  assert.equal(view.notInForce, undefined);
});

test("a crash cell under the next code passes the permission and reaches its own row", async () => {
  const f = await fixture();
  await f.worker(before).configure("enable", f.configuration);
  const deployed = f.worker(after);
  const target = f.launch();
  const identity = { ...target, bootId: "22222222-2222-2222-2222-222222222222" };
  await deployed.state.reserve(target);
  await deployed.state.dispatch(target);
  await deployed.state.redraw(identity, undefined);
  const at = Date.now();
  // The row is draining, so the command refuses it as draining, past the permission check.
  await assert.rejects(
    deployed.crash({
      controllerCode: after,
      action: "runtime-crash",
      identity,
      nonce: "crash-1",
      operator: "release-owner",
      at,
      expiresAt: at + 20_000,
      kind: "cell",
    }),
    /draining/,
  );
});

test("a primary promotion under the next code keeps the permission", async () => {
  const f = await fixture();
  await f.worker(before).configure("enable", f.configuration);
  const deployed = f.worker(after);
  const green = f.applications[1]!;
  const candidate = {
    ...f.legacy,
    slotId: "promoted",
    applicationId: green.applicationId,
    applicationVersion: green.applicationVersion,
    imageDigest: green.imageDigest,
    imageInput: green.imageInput,
    instanceId: "b".repeat(64),
  };
  await f.storage.transaction((transaction) =>
    deployed.configuration.promotePrimary(
      {
        operationId: "promote",
        controllerCode: after,
        expectedEpoch: 1,
        policyDigest: "6".repeat(64),
        previous: f.legacy,
        candidate,
      },
      transaction,
    ),
  );
  const record = await deployed.configuration.inspect();
  assert.equal(record?.configuration.revision, 2);
  assert.equal(record?.configuration.active, "green");
  assert.equal((await deployed.inspect()).inForce, true);
});

test("a configure under the next code still refuses a configuration signed for the last", async () => {
  const f = await fixture();
  const first = await f.worker(before).configure("enable", f.configuration);
  const next = { ...f.configuration, revision: 2, previousDigest: first.digest };
  await assert.rejects(f.worker(after).configure("again", next), /identity/);
  const committed = await f.worker(after).configure("again-signed", {
    ...next,
    controllerCode: after,
  });
  assert.equal(committed.configuration.revision, 2);
});

test("inspect says why a stored permission is not in force, and launches agree", async () => {
  const f = await fixture();
  const first = await f.worker(before).configure("enable", f.configuration);
  // An image release changes the Worker's bound image input; the stored permission names the old.
  f.rebind(
    f.applications.map((app) =>
      app.color === "blue" ? { ...app, imageInput: "9".repeat(16) } : app,
    ),
  );
  const imaged = f.worker(after);
  assert.deepEqual(
    { inForce: (await imaged.inspect()).inForce, notInForce: (await imaged.inspect()).notInForce },
    { inForce: false, notInForce: "bindings" },
  );
  await assert.rejects(imaged.state.reserve(f.launch()), /identity/);
  f.rebind(f.applications);
  const deployed = f.worker(after);
  await deployed.disable("stop", first.digest);
  const view = await deployed.inspect();
  assert.deepEqual(
    { inForce: view.inForce, notInForce: view.notInForce },
    { inForce: false, notInForce: "disabled" },
  );
  await assert.rejects(deployed.state.reserve(f.launch()), /selection/);
});
