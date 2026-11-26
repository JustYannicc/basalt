import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { decodeReleasePolicy } from "./policy.ts";
import {
  routeGatewayClassFor,
  routeGatewayFqn,
  routeGatewayRecorded,
} from "./route-gateway-class.ts";

const read = async (name: string) =>
  decodeReleasePolicy(
    JSON.parse(await readFile(new URL(`./policies/${name}.json`, import.meta.url), "utf8")),
  );
// Every policy a release runs under but the route gateway's own class change.
const ordinary = ["release", "code", "code-restart", "cutover-code", "cutover-classes"];

test("before the class is declared, no ordinary release declares it", async () => {
  // Nothing is recorded until the declare release creates the class's application, so whichever
  // of this change and the route gateway's code reaches main first, the next ordinary release
  // plans no change for it and is not refused.
  for (const name of ordinary) {
    const policy = await read(name);
    assert.equal(policy.env.ROUTE_GATEWAY_CLASS, undefined, name);
    assert.equal(routeGatewayClassFor(policy.env.ROUTE_GATEWAY_CLASS, false), "absent", name);
  }
});

test("once the class is declared, every ordinary release keeps it, so none plans its removal", async () => {
  for (const name of ordinary) {
    const policy = await read(name);
    assert.equal(routeGatewayClassFor(policy.env.ROUTE_GATEWAY_CLASS, true), "declared", name);
  }
});

test("the declare release declares the class whether or not a run before it got halfway", async () => {
  const declare = await read("route-gateway-class");
  assert.equal(declare.env.ROUTE_GATEWAY_CLASS, "declared");
  for (const recorded of [false, true])
    assert.equal(routeGatewayClassFor(declare.env.ROUTE_GATEWAY_CLASS, recorded), "declared");
});

test("the absent opt-out wins over the record, and only a policy can give it", () => {
  // The plan it leads to drops the RouteGateway binding, which the plan check refuses
  // ("a Durable Object binding removed from a Worker is refused", plan-check.test.ts): the
  // opt-out can show that plan, never apply it.
  assert.equal(routeGatewayClassFor("absent", true), "absent");
  assert.equal(routeGatewayFqn, "RouteGateway");
});

test("the declare policy creates exactly the route gateway's class and application, and moves no code", async () => {
  const declare = await read("route-gateway-class");
  const fleet = await read("cutover-classes");
  const code = await read("code");
  assert.equal(declare.check.mode, "cutover-classes");
  assert.deepEqual(
    declare.check.allow.map((entry) => [entry.fqn, entry.action]),
    [
      ["PoolWorker", "update"],
      ["RouteGateway", "create"],
      ["PoolBackendBudgetRuntimeReady", "update"],
    ],
  );
  assert.deepEqual(declare.check.removals, []);
  assert.deepEqual(declare.wire.sqliteClasses, { PoolWorker: ["RouteGateway"] });
  assert.deepEqual(declare.wire.expectLiveModule, ["PoolWorker"]);
  assert.deepEqual(declare.include, fleet.include);
  // The same protections and root rules as the fleet's class change.
  assert.deepEqual(declare.check.protected, fleet.check.protected);
  assert.deepEqual(declare.check.poolContainer, fleet.check.poolContainer);
  // The fleet stays where the code release keeps it: this release changes no other class.
  assert.equal(declare.env.POOL_FLEET_CLASSES, code.env.POOL_FLEET_CLASSES);
  assert.equal(declare.env.POOL_FLEET_BUILD, undefined);
  // A class change has no rollback step: Cloudflare refuses a Worker rollback across one.
  assert.equal(declare.rollback, undefined);
  assert.equal(declare.acceptance, undefined);
});

test("no other policy may create the route gateway's class", async () => {
  for (const name of ordinary)
    for (const classes of Object.values((await read(name)).wire.sqliteClasses))
      assert.ok(!classes.includes("RouteGateway"), name);
});

test("only PoolWorker hosting the class counts as declared, not the application's row", () => {
  // Alchemy records the application's row when it publishes the image, uploads PoolWorker with
  // the class next, and creates the application last. A declare that stopped after the upload
  // has the class, and ordinary releases must keep it; one that stopped before has none.
  assert.equal(routeGatewayRecorded(["PoolLedger", "RouteGateway"]), true);
  assert.equal(routeGatewayRecorded(["PoolLedger"]), false);
  assert.equal(routeGatewayRecorded([]), false);
});

test("the entry sets the class switch before the planning session copies the environment", async () => {
  // Alchemy's session copies process.env when it opens, so a value set inside the planning run is
  // never seen by the stack. The switch is set between a first, read-only run and the planning one.
  const entry = await readFile(new URL("./deploy.ts", import.meta.url), "utf8");
  const branch = entry.indexOf(
    'if (command === "plan" || command === "apply" || command === "deploy") {',
  );
  const set = entry.indexOf("process.env.ROUTE_GATEWAY_CLASS = routeGatewayClassFor(", branch);
  const planning = entry.indexOf("const result = await run(", branch);
  assert.ok(branch > 0 && set > branch && planning > set, "set the switch before the planning run");
  assert.equal(entry.split("process.env.ROUTE_GATEWAY_CLASS =").length, 2, "set in one place only");
});
