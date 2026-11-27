import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpStatusFailure } from "./pool-acceptance/types.ts";
import {
  classesDeclared,
  classChanges,
  databaseSteps,
  forwardVersion,
  rootChange,
  removals,
  fleetEnvironment,
  routeGatewayEnvironment,
  workersToRepoint,
} from "./production.ts";
import { errorLine } from "./release/failure-line.ts";
import { assignEnvironment } from "./release/process-env.ts";
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

test("the route gateway's class stays declared once PoolWorker hosts it, and is unset before", () => {
  assert.deepEqual(routeGatewayEnvironment([]), { ROUTE_GATEWAY_CLASS: "absent" });
  assert.deepEqual(routeGatewayEnvironment(["PoolLedger", "PoolRuntimeBlue"]), {
    ROUTE_GATEWAY_CLASS: "absent",
  });
  assert.deepEqual(routeGatewayEnvironment(["PoolLedger", "RouteGateway"]), {
    ROUTE_GATEWAY_CLASS: "declared",
  });
  // An ambient value cannot declare the class through an ordinary deploy, whatever the stack's default.
  const env: Record<string, string | undefined> = { ROUTE_GATEWAY_CLASS: "declared" };
  assignEnvironment(env, routeGatewayEnvironment([]));
  assert.equal(env.ROUTE_GATEWAY_CLASS, "absent");
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

test("each plan row says why it is in the plan, by name only, and a noop row prints nothing", async () => {
  const { rowLine, withReasons } = await import("./release/approved-plan.ts");
  const worker = (
    fqn: string,
    action: string,
    bindings: { sid: string; action: string }[] = [],
  ) => ({
    fqn,
    resourceType: "Cloudflare.Worker",
    action,
    bindings,
  });
  const rows = withReasons(
    [
      worker("Dashboard", "update", [{ sid: "ASSETS", action: "noop" }]),
      worker("PoolWorker", "update", [{ sid: "POOL_CONTAINER", action: "update" }]),
      worker("Api", "update", [
        { sid: "KV", action: "create" },
        { sid: "DB", action: "update" },
      ]),
      worker("Router", "noop", [{ sid: "POOL", action: "noop" }]),
      worker("AppPages", "noop", [{ sid: "PAGES", action: "update" }]),
      worker("Marketing", "update"),
      worker("NewSite", "create"),
    ],
    [
      { fqn: "Dashboard", changedProps: ["env", "assets"] },
      { fqn: "PoolWorker", changedProps: [] },
      { fqn: "Api", changedProps: ["main"] },
      { fqn: "AppPages", changedProps: [] },
      { fqn: "Marketing", changedProps: [] },
      { fqn: "NewSite", changedProps: ["name", "main"] },
    ],
  );
  assert.deepEqual(rows.map(rowLine), [
    // A prop-only update names the props, sorted.
    "Dashboard Cloudflare.Worker update: props assets, env",
    // A binding-only update says so in words, with each binding's id and action.
    "PoolWorker Cloudflare.Worker update only by its bindings, no prop changes: bindings POOL_CONTAINER update",
    // Both.
    "Api Cloudflare.Worker update: props main; bindings DB update, KV create",
    // A noop row whose bindings are noop too is not part of the plan.
    undefined,
    "AppPages Cloudflare.Worker noop, bindings changed: bindings PAGES update",
    // A code-only update: the provider compares the bundle and assets hashes itself.
    "Marketing Cloudflare.Worker update by the provider's own diff (code, assets or metadata), no prop or binding changes",
    // A new resource is all new, so it names no props.
    "NewSite Cloudflare.Worker create",
  ]);
});

test("the digest covers why each row is in the plan; a deploy still refuses rows that differ", async () => {
  const { planDifference, planDigest } = await import("./release/approved-plan.ts");
  const plan = {
    candidate: "8e7de242458798cade20330fb1924476d6a53013",
    declared: true,
    rows: [
      {
        fqn: "Dashboard",
        resourceType: "Cloudflare.Worker",
        action: "update",
        changedProps: ["assets", "env"],
        bindings: [{ sid: "ASSETS", action: "noop" }],
      },
      {
        fqn: "PoolWorker",
        resourceType: "Cloudflare.Worker",
        action: "update",
        changedProps: ["main"],
      },
    ],
    actions: [],
    created: [],
    forward: [],
  };
  const approved = planDigest(plan);
  // The same plan, props in another order: the same digest, so it deploys.
  assert.equal(
    planDifference(approved, {
      ...plan,
      rows: [...plan.rows]
        .reverse()
        .map((row) => ({ ...row, changedProps: [...row.changedProps].reverse() })),
    }),
    undefined,
  );
  const otherProps = {
    ...plan,
    rows: plan.rows.map((row) =>
      row.fqn === "Dashboard" ? { ...row, changedProps: ["env"] } : row,
    ),
  };
  const otherBinding = {
    ...plan,
    rows: plan.rows.map((row) =>
      row.fqn === "Dashboard" ? { ...row, bindings: [{ sid: "ASSETS", action: "update" }] } : row,
    ),
  };
  const extraRow = {
    ...plan,
    rows: [
      ...plan.rows,
      { fqn: "McpServer", resourceType: "Cloudflare.Worker", action: "update", changedProps: [] },
    ],
  };
  const otherAction = {
    ...plan,
    rows: plan.rows.map((row) => (row.fqn === "PoolWorker" ? { ...row, action: "replace" } : row)),
  };
  for (const [name, candidate] of [
    ["other props", otherProps],
    ["another binding", otherBinding],
    ["an extra row", extraRow],
    ["another action", otherAction],
  ] as const) {
    const refusal = planDifference(approved, candidate);
    assert.ok(refusal, `${name} refuses`);
    assert.match(refusal, /nothing applied/u);
  }
  assert.match(
    planDifference(approved, otherProps)!,
    /Dashboard Cloudflare\.Worker update: props env/u,
  );
  assert.match(
    planDifference(approved, extraRow)!,
    /McpServer Cloudflare\.Worker update by the provider's own diff/u,
  );
});

test("on Alchemy's own plan, a row names what its changed prop waits on, and the digest is what is printed", async (context) => {
  const { changedRows } = await import("./release/plan-summary.ts");
  const { planDigest, planLines, rowLine, withReasons } =
    await import("./release/approved-plan.ts");
  // PoolWorker's env gains a value that waits on the pool database's command, which this plan runs.
  const reading = async () => {
    const { plan } = await makePlan(context, {
      rows: productionRows(),
      declared: { poolWorkerWaitsOnCommand: true },
    });
    const native = plan as never as {
      resources: Record<
        string,
        { action: string; resource: { Type: string }; bindings?: { sid: string; action: string }[] }
      >;
    };
    const resources = Object.entries(native.resources).map(([fqn, node]) => ({
      fqn,
      resourceType: node.resource.Type,
      action: node.action,
      bindings: (node.bindings ?? []).map(({ sid, action }) => ({ sid, action })),
    }));
    const rows = withReasons(
      resources,
      changedRows({ resources, summary: {}, native: plan as never }),
    );
    return {
      lines: rows.flatMap((row) => rowLine(row) ?? []),
      digestOf: {
        candidate: "0".repeat(40),
        declared: true,
        rows,
        actions: [],
        created: [],
        forward: [],
      },
    };
  };
  const first = await reading();
  const pool = first.lines.find((line) => line.startsWith("PoolWorker "));
  assert.match(pool ?? "", /props [^;]*env \(waits on [A-Za-z]+[^)]*\)/u);
  // What the plan prints is exactly what the digest covers.
  assert.deepEqual(
    planLines(first.digestOf).filter(
      (line) => !line.includes(" class created") && !line.includes(" re-point forward"),
    ),
    [...first.lines].sort(),
  );
  // The same stack planned again reads the same, so a deploy's re-plan matches its plan-only run.
  assert.equal(planDigest((await reading()).digestOf), planDigest(first.digestOf));
});
