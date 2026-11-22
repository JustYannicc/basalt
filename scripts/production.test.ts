import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpStatusFailure } from "./pool-acceptance/types.ts";
import {
  classesDeclared,
  classChanges,
  databaseSteps,
  errorLine,
  forwardVersion,
  rootChange,
  removals,
  fleetEnvironment,
  smoke,
  workersToRepoint,
} from "./production.ts";
import { errorKind } from "./release/public-report.ts";
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

test("a plan that stops binding a class a Worker hosts is a drop; the fleet's classes are creates", async (context) => {
  const kept = await makePlan(context, { rows: productionRows() });
  assert.deepEqual(classChanges(kept.plan as never).dropped, []);
  const created = await makePlan(context, {
    rows: productionRows(),
    declared: { fleetClasses: true },
  });
  assert.deepEqual(classChanges(created.plan as never), {
    dropped: [],
    created: ["PoolWorker: PoolRuntimeBlue", "PoolWorker: PoolRuntimeGreen"],
  });
  const dropped = await makePlan(context, {
    rows: productionRows(),
    declared: { ledger: undefined },
  });
  assert.deepEqual(classChanges(dropped.plan as never).dropped, ["PoolWorker: PoolLedger"]);
});

test("deleting or replacing a Worker drops every class it hosts", () => {
  const own = {
    sid: "Ledger",
    data: { bindings: [{ type: "durable_object_namespace", className: "Ledger" }] },
  };
  const other = {
    sid: "Far",
    data: { bindings: [{ type: "durable_object_namespace", className: "Far", scriptName: "x" }] },
  };
  const worker = (action: string) => ({
    resource: { Type: "Cloudflare.Worker" },
    action,
    bindings: [{ sid: "Ledger", action: "noop" }],
    state: { bindings: [own, other] },
  });
  assert.deepEqual(
    classChanges({
      resources: { Kept: worker("update"), New: worker("replace") },
      deletions: { Gone: worker("delete") },
    }).dropped,
    ["Gone: Ledger", "New: Ledger"],
  );
});

test("a plan that deletes or replaces a data resource is refused, and code is not", () => {
  const row = (fqn: string, resourceType: string, action: string) => ({
    fqn,
    resourceType,
    action,
  });
  assert.deepEqual(
    removals({
      resources: [
        row("Api", "Cloudflare.Worker", "replace"),
        row("PoolBackendBudget", "Command.Exec", "delete"),
        row("Vault", "Cloudflare.R2.Bucket", "replace"),
        row("Router", "Cloudflare.Worker", "update"),
      ],
      native: {
        resources: {},
        deletions: { PoolDatabaseBranch: { resource: { Type: "Planetscale.PostgresBranch" } } },
      },
    }),
    [
      "Vault (Cloudflare.R2.Bucket) replace",
      "PoolDatabaseBranch (Planetscale.PostgresBranch) delete",
    ],
  );
});

test("a Worker a rollback left behind goes forward to the last release's version", () => {
  const deployment = (message: string, versions: { version_id: string; percentage: number }[]) => ({
    annotations: { "workers/message": message },
    versions,
  });
  const at = (id: string) => [{ version_id: id, percentage: 100 }];
  // No rollback serves: nothing to do.
  assert.equal(forwardVersion([deployment("Automatic deployment", at("v2"))]), undefined);
  assert.equal(forwardVersion([]), undefined);
  // Ours and the old entry's rollbacks, one or stacked: the release before them.
  assert.equal(
    forwardVersion([deployment("production smoke failed", at("v1")), deployment("", at("v2"))]),
    "v2",
  );
  assert.equal(
    forwardVersion([
      deployment("release rollback 44992011040", at("v1")),
      deployment("production smoke failed", at("v1")),
      deployment("Automatic deployment", at("v3")),
    ]),
    "v3",
  );
  // A forward re-point is no rollback: the next run leaves it alone.
  assert.equal(forwardVersion([deployment("production re-point forward", at("v2"))]), undefined);
  // That version cannot be told: a split, or no release listed behind the rollback.
  const split = [
    { version_id: "v2", percentage: 50 },
    { version_id: "v1", percentage: 50 },
  ];
  assert.equal(
    forwardVersion([deployment("production smoke failed", at("v1")), deployment("", split)]),
    null,
  );
  assert.equal(forwardVersion([deployment("production smoke failed", at("v1"))]), null);
});

test("the root may only update its attachment; any prop change or replace is refused", () => {
  assert.equal(rootChange(undefined), "untouched");
  // Production's shape whenever the pool Worker updates (carry 0696).
  assert.equal(rootChange({ action: "update", changedProps: [] }), "attachment");
  assert.equal(rootChange({ action: "update", changedProps: ["image"] }), "refused");
  assert.equal(rootChange({ action: "replace", changedProps: [] }), "refused");
  assert.equal(rootChange({ action: "delete", changedProps: [] }), "refused");
});

test("a backup is taken only for a plan that runs a database command", () => {
  const row = (fqn: string, action: string) => ({ fqn, action });
  assert.deepEqual(
    databaseSteps([
      row("Api", "update"),
      row("Migrations", "update"),
      row("PoolDatabase", "noop"),
      row("PoolBackendBudget", "update"),
    ]),
    ["Migrations"],
  );
  assert.deepEqual(databaseSteps([row("PoolDatabase", "noop"), row("Router", "update")]), []);
});

test("an error prints as its class and kind, never as an object", () => {
  assert.equal(
    errorLine(errorKind(new HttpStatusFailure(403, "/v1/chat/completions returned HTTP 403"))),
    "Error (refused, HTTP 403)",
  );
  assert.equal(
    errorLine({ errorClass: "ContainerBuildFailed", kind: "failed" }),
    "ContainerBuildFailed (failed)",
  );
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
