import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpStatusFailure } from "./pool-acceptance/types.ts";
import {
  classesDeclared,
  droppedClasses,
  fleetEnvironment,
  smoke,
  workersToRepoint,
} from "./production.ts";
import { makePlan, productionRows } from "./release/test/plan-fixture.ts";

test("the class switch only turns the fleet's classes on, and each state has one env shape", () => {
  assert.equal(classesDeclared(false, []), false);
  assert.equal(classesDeclared(true, []), true);
  // Once PoolWorker hosts them they stay declared, whatever the switch says.
  assert.equal(classesDeclared(false, ["PoolLedger", "PoolRuntimeBlue"]), true);
  assert.deepEqual(fleetEnvironment(false), {
    POOL_FLEET_BUILD: undefined,
    POOL_FLEET_CLASSES: "absent",
  });
  assert.deepEqual(fleetEnvironment(true), {
    POOL_FLEET_BUILD: "true",
    POOL_FLEET_CLASSES: undefined,
  });
});

test("a failed smoke re-points every Worker the apply uploads, and nothing else", () => {
  const node = (Type: string, action: string, bindings: { action: string }[] = []) => ({
    resource: { Type },
    action,
    bindings,
  });
  const plan = {
    resources: {
      Router: node("Cloudflare.Worker", "update"),
      Api: node("Cloudflare.Worker", "noop", [{ action: "update" }]),
      Site: node("Cloudflare.Worker", "noop", [{ action: "noop" }]),
      // A new Worker has no earlier version to go back to.
      Fresh: node("Cloudflare.Worker", "create"),
      PoolDatabase: node("Command.Exec", "update"),
      Gone: undefined,
    },
  };
  assert.deepEqual(workersToRepoint(plan), ["Api", "Router"]);
});

test("a plan that stops binding a class PoolWorker hosts is refused; creating classes is not", async (context) => {
  const kept = await makePlan(context, { rows: productionRows() });
  assert.deepEqual(droppedClasses(kept.plan as never), []);
  const created = await makePlan(context, {
    rows: productionRows(),
    declared: { fleetClasses: true },
  });
  assert.deepEqual(droppedClasses(created.plan as never), []);
  const dropped = await makePlan(context, {
    rows: productionRows(),
    declared: { ledger: undefined },
  });
  assert.deepEqual(droppedClasses(dropped.plan as never), ["PoolWorker: PoolLedger"]);
});

test("the smoke passes on a served turn and names a failure by class and status only", async () => {
  assert.deepEqual(await smoke(async () => ({ boot: "b" })), { passed: true });
  assert.deepEqual(
    await smoke(async () => {
      throw new HttpStatusFailure(503, "/v1/chat/completions returned HTTP 503");
    }),
    { passed: false, why: "Error, HTTP 503" },
  );
  const failed = await smoke(async () => {
    throw new Error("connect failed to a host name");
  });
  assert.deepEqual(failed, { passed: false, why: "Error" });
});
