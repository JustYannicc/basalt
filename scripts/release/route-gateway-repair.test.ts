import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import type * as Plan from "alchemy/Plan";
import { Cause, Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { checkPlan, decodePlanPolicy, PlanRefused } from "./plan-check.ts";
import {
  applyRepair,
  listApplications,
  readRepair,
  RepairRefused,
  repairDigest,
  type RepairStore,
} from "./placeholder-repair.ts";
import { decodeReleasePolicy } from "./policy.ts";
import { routeGatewayClassFor, routeGatewayRecorded } from "./route-gateway-class.ts";
import { asDeclared, declareTo, seeded, type Outcome, type Rows } from "./test/declare-run.ts";
import {
  cloudflare,
  makePlan,
  pinnedImage,
  type ContainerApplicationBody,
} from "./test/plan-fixture.ts";

// Every way the declare can stop after Alchemy committed the application's placeholder row.
const stops: Outcome[] = ["upload-refused", "create-refused", "commit-lost"];

const policies = async () =>
  (await readdir(new URL("./policies/", import.meta.url)))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
const policyFile = async (name: string) =>
  decodeReleasePolicy(
    JSON.parse(await readFile(new URL(`./policies/${name}.json`, import.meta.url), "utf8")),
  );

const verdict = async (plan: Plan.Plan, name: string) => {
  const { check, include } = await policyFile(name);
  const policy = await Effect.runPromise(
    decodePlanPolicy({
      ...check,
      poolContainer: { ...check.poolContainer, image: pinnedImage },
      ...(include ? { include } : {}),
    }),
  );
  const exit = await Effect.runPromiseExit(checkPlan(plan, policy));
  if (Exit.isSuccess(exit)) return [];
  const error = Cause.squash(exit.cause);
  assert.ok(error instanceof PlanRefused, String(error));
  return error.violations.map((v) => `${v.rule} ${v.fqn} ${v.action}`).sort();
};

/** Plans `rows` as a release under the policy would: its selection, its switches. */
const planAs = async (
  context: TestContext,
  rows: Rows,
  name: string,
  applications: Map<string, ContainerApplicationBody>,
) => {
  const { include, env } = await policyFile(name);
  const pool = rows.PoolWorker as unknown as {
    attr?: { durableObjectNamespaces?: object };
    old?: { attr?: { durableObjectNamespaces?: object } };
  };
  // The switch exactly as the release entry derives it (deploy.ts).
  const hosted = [pool, pool.old].flatMap((row) =>
    Object.keys(row?.attr?.durableObjectNamespaces ?? {}),
  );
  const routeGateway =
    routeGatewayClassFor(env.ROUTE_GATEWAY_CLASS, routeGatewayRecorded(hosted)) === "declared";
  return Effect.runPromiseExit(
    Effect.tryPromise(() =>
      makePlan(context, {
        rows,
        declared: {
          poolDatabase: {},
          routeGateway,
          ...(env.POOL_FLEET_BUILD === "true" ? { fleetClasses: true } : {}),
        },
        ...(include ? { include: [...include] } : {}),
        commandRuns: [],
        applications,
      }),
    ),
  );
};

/** An error and its causes on one line: the planner's refusal sits under the fixture's wrapper. */
const causes = (error: unknown) => {
  const lines: string[] = [];
  for (let at = error; at && lines.length < 8; at = (at as { cause?: unknown }).cause)
    lines.push(
      `${(at as { _tag?: string })._tag ?? ""}: ${(at as { message?: string }).message ?? ""}`,
    );
  return lines.join(" <- ");
};
const action = (plan: Plan.Plan, fqn: string): string =>
  (plan.resources[fqn] ?? plan.deletions[fqn])?.action ?? "absent";
const actions = (plan: Plan.Plan) =>
  Object.fromEntries(
    Object.entries(plan.resources)
      .filter(([, node]) => node && node.action !== "noop")
      .map(([fqn, node]) => [fqn, node!.action]),
  );

/**
 * The repair's State is the rows themselves; its account is a fake Cloudflare API serving the
 * applications, read through the provider's own SDK call.
 */
const repairOn = async (
  context: TestContext,
  rows: Rows,
  applications: Map<string, ContainerApplicationBody>,
) => {
  const account = await cloudflare(context, false, { applications, acceptCreates: false });
  const store: RepairStore<never> = {
    get: (fqn) => Effect.sync(() => rows[fqn]),
    set: (fqn, value) => Effect.sync(() => void (rows[fqn] = value as Rows[string])),
    delete: (fqn) => Effect.sync(() => void delete rows[fqn]),
  };
  return {
    fqn: "RouteGateway",
    worker: "PoolWorker",
    store,
    list: (accountId: string) =>
      listApplications(
        Redacted.make("synthetic-token"),
        account.base,
      )(accountId).pipe(Effect.provide(FetchHttpClient.layer)),
  };
};

for (const stop of stops)
  test(`no release plans past the placeholder a declare that stopped at ${stop} left`, async (context) => {
    const applications = new Map<string, ContainerApplicationBody>();
    const { rows } = await declareTo(context, stop, applications);
    const touched: string[] = [];
    for (const name of await policies()) {
      const exit = await planAs(context, rows, name, applications);
      if (Exit.isFailure(exit)) {
        // Alchemy refused to plan: it would replace the row inside a filtered plan.
        assert.match(
          causes(Cause.squash(exit.cause)),
          /UnsafeSelectionBoundary: Cannot replace .*'RouteGateway'/u,
          name,
        );
        touched.push(name);
        continue;
      }
      const { plan } = exit.value;
      const row = action(plan, "RouteGateway");
      if (row === "noop" || row === "absent") continue;
      touched.push(name);
      assert.ok(
        (await verdict(plan, name)).includes(
          `container-placeholder-not-created RouteGateway ${row}`,
        ),
        `${name} plans ${row} of the placeholder without the placeholder rule`,
      );
    }
    // Not vacuous: the automatic release meets the row, and so does the declare run again.
    assert.ok(touched.includes("code") && touched.includes("route-gateway-class"), `${touched}`);
  });

for (const stop of ["upload-refused", "create-refused"] as const)
  test(`a declare stopped at ${stop} is repaired by forgetting the placeholder, then declared again`, async (context) => {
    const applications = new Map<string, ContainerApplicationBody>();
    const fresh = await makePlan(context, { rows: await seeded(context), ...asDeclared });
    const { rows } = await declareTo(context, stop, applications);
    const { plan } = await Effect.runPromise(
      readRepair(await repairOn(context, rows, applications)),
    );
    assert.equal(plan.action, "forget");
    await Effect.runPromise(
      applyRepair({ ...(await repairOn(context, rows, applications)), digest: repairDigest(plan) }),
    );
    assert.equal(rows.RouteGateway, undefined);
    // The declare's own plan and verdict are then a fresh declare's.
    const again = await makePlan(context, { rows, ...asDeclared, applications });
    assert.equal(action(again.plan, "RouteGateway"), "create");
    assert.deepEqual(actions(again.plan), actions(fresh.plan));
    assert.deepEqual(
      await verdict(again.plan, "route-gateway-class"),
      await verdict(fresh.plan, "route-gateway-class"),
    );
  });

test("a declare whose create landed but whose commit was lost is repaired by adopting the live application", async (context) => {
  const applications = new Map<string, ContainerApplicationBody>();
  const { rows } = await declareTo(context, "commit-lost", applications);
  const [live] = [...applications.values()];
  assert.ok(live, "the create reached the account");
  const { plan } = await Effect.runPromise(readRepair(await repairOn(context, rows, applications)));
  assert.deepEqual(plan.action === "adopt" ? [plan.application, plan.namespace] : plan.action, [
    live.id,
    "namespace-route-gateway",
  ]);
  await Effect.runPromise(
    applyRepair({ ...(await repairOn(context, rows, applications)), digest: repairDigest(plan) }),
  );
  // The next release reads the row as the live application: never a create beside it, a replace or
  // a delete of it, under any policy.
  for (const name of await policies()) {
    const exit = await planAs(context, rows, name, applications);
    assert.ok(Exit.isSuccess(exit), `${name} plans the adopted row`);
    const row = action(exit.value.plan, "RouteGateway");
    assert.ok(row === "noop" || row === "update" || row === "absent", `${name}: ${row}`);
    const route = (await verdict(exit.value.plan, name)).filter(
      (v) =>
        v.startsWith("container-placeholder-not-created") ||
        v.startsWith("protected-resource-destroyed RouteGateway"),
    );
    assert.deepEqual(route, [], name);
  }
});

test("the repair touches nothing but a placeholder it can account for", async (context) => {
  const refused = async (rows: Rows, applications: Map<string, ContainerApplicationBody>) => {
    const exit = await Effect.runPromiseExit(
      readRepair(await repairOn(context, rows, applications)),
    );
    assert.ok(Exit.isFailure(exit), "the repair planned");
    const error = Cause.squash(exit.cause);
    assert.ok(error instanceof RepairRefused, String(error));
    return error.reason;
  };
  // A finished declare records the live application: nothing to repair.
  const done = new Map<string, ContainerApplicationBody>();
  const finished = await declareTo(context, "finished", done);
  assert.match(await refused(finished.rows, done), /live application/u);

  const applications = new Map<string, ContainerApplicationBody>();
  const { rows } = await declareTo(context, "commit-lost", applications);
  const [live] = [...applications.values()];
  // Two applications under the name: which is the row's cannot be told.
  const twice = new Map(applications).set("second", { ...live!, id: "second" });
  assert.match(await refused(rows, twice), /2 applications/u);
  // One attached to another namespace than the Worker records is not the row's.
  const elsewhere = new Map([[live!.id, { ...live!, durable_objects: { namespace_id: "other" } }]]);
  assert.match(await refused(rows, elsewhere), /another namespace/u);
  // A row written in local mode, or with a generated name, is not one the repair can account for.
  const local = { ...rows, RouteGateway: { ...rows.RouteGateway!, providerMode: "local" } } as Rows;
  assert.match(await refused(local, applications), /local mode/u);
  const generated = {
    ...rows,
    RouteGateway: {
      ...rows.RouteGateway!,
      props: { ...(rows.RouteGateway!.props as object), name: undefined },
    },
  } as Rows;
  assert.match(await refused(generated, applications), /explicitly named/u);

  // An approved repair is applied only while it is still the repair the reviewer saw.
  const { plan } = await Effect.runPromise(readRepair(await repairOn(context, rows, applications)));
  const stale = await Effect.runPromiseExit(
    applyRepair({ ...(await repairOn(context, rows, new Map())), digest: repairDigest(plan) }),
  );
  assert.ok(Exit.isFailure(stale) && Cause.squash(stale.cause) instanceof RepairRefused);
  assert.ok(rows.RouteGateway, "a refused repair changed nothing");
});

test("a declared gateway does not block the fleet's class change, and only the allowance admits its attachment", async (context) => {
  const applications = new Map<string, ContainerApplicationBody>();
  const { rows } = await declareTo(context, "finished", applications);
  const exit = await planAs(context, rows, "cutover-classes", applications);
  assert.ok(Exit.isSuccess(exit), String(Exit.isFailure(exit) && Cause.squash(exit.cause)));
  const { plan } = exit.value;
  // The fleet's new classes move PoolWorker, so the gateway's attachment waits on it.
  assert.equal(action(plan, "RouteGateway"), "update");
  const route = (await verdict(plan, "cutover-classes")).filter((v) =>
    v.includes(" RouteGateway "),
  );
  assert.deepEqual(route, []);

  // Without the allowance the same row is refused: the allowance is what admits it.
  const { check, include } = await policyFile("cutover-classes");
  const without = await Effect.runPromise(
    decodePlanPolicy({
      ...check,
      attachmentOnly: [],
      poolContainer: { ...check.poolContainer, image: pinnedImage },
      ...(include ? { include } : {}),
    }),
  );
  const refusedWithout = await Effect.runPromiseExit(checkPlan(plan, without));
  assert.ok(
    Exit.isFailure(refusedWithout) &&
      (Cause.squash(refusedWithout.cause) as PlanRefused).violations.some(
        (v) => v.fqn === "RouteGateway" && v.rule === "outside-cutover-classes",
      ),
  );
});

test("the fleet's class change still refuses a real change to the declared gateway", async (context) => {
  const applications = new Map<string, ContainerApplicationBody>();
  const { rows } = await declareTo(context, "finished", applications);
  const { include } = await policyFile("cutover-classes");
  const { plan } = await makePlan(context, {
    rows,
    declared: { poolDatabase: {}, routeGateway: { instanceType: "standard" }, fleetClasses: true },
    ...(include ? { include: [...include] } : {}),
    commandRuns: [],
    applications,
  });
  assert.equal(action(plan, "RouteGateway"), "update");
  assert.ok(
    (await verdict(plan, "cutover-classes")).includes(
      "outside-cutover-classes RouteGateway update",
    ),
  );
});

test("every policy that admits a container's attachment holds its application at the wire", async () => {
  for (const name of await policies()) {
    const { check, wire } = await policyFile(name);
    for (const fqn of check.attachmentOnly ?? [])
      assert.ok(wire.heldApplications?.includes(fqn), `${name}: ${fqn}`);
  }
});
