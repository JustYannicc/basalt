import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type * as Plan from "alchemy/Plan";
import { Cause, Effect, Exit } from "effect";
import { checkPlan, decodePlanPolicy, PlanRefused, sameDeclaration } from "./plan-check.ts";
import {
  applyRepair,
  type Observation,
  readRepair,
  RepairRefused,
  repairDigest,
  type RepairStore,
} from "./placeholder-repair.ts";
import { decodeReleasePolicy } from "./policy.ts";
import { routeGatewayClassFor, routeGatewayRecorded } from "./route-gateway-class.ts";
import { asDeclared, declareTo, seeded, type Outcome, type Rows } from "./test/declare-run.ts";
import { accountId, makePlan, pinnedImage, type FakeApplication } from "./test/plan-fixture.ts";

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
  applications: Map<string, FakeApplication>,
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
 * The repair's State is the rows themselves. Its account read is the provider's own read of the
 * row (`observeRow`) against the fake account, run with the fixture's providers.
 */
const repairOn = (context: TestContext, rows: Rows, applications: Map<string, FakeApplication>) => {
  const store: RepairStore<never> = {
    get: (fqn) => Effect.sync(() => rows[fqn]),
    set: (fqn, value) => Effect.sync(() => void (rows[fqn] = value as Rows[string])),
    delete: (fqn) => Effect.sync(() => void delete rows[fqn]),
  };
  const observe = (fqn: string) =>
    Effect.promise(async () => {
      const read: { fqn: string; result?: Observation | undefined } = { fqn };
      await makePlan(context, {
        rows,
        declared: { poolDatabase: {} },
        commandRuns: [],
        applications,
        observe: read,
      });
      return read.result;
    });
  return { fqn: "RouteGateway", worker: "PoolWorker", store, observe };
};

for (const stop of stops)
  test(`no release plans past the placeholder a declare that stopped at ${stop} left`, async (context) => {
    const applications = new Map<string, FakeApplication>();
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
    // Not vacuous: the automatic release, the declare run again and an ordinary release meet the row.
    // `release` is the one policy whose only refusal of the row is the placeholder rule itself.
    for (const name of ["code", "route-gateway-class", "release"])
      assert.ok(touched.includes(name), `${name} never met the row: ${touched}`);
  });

for (const stop of ["upload-refused", "create-refused"] as const)
  test(`a declare stopped at ${stop} is repaired by forgetting the placeholder, then declared again`, async (context) => {
    const applications = new Map<string, FakeApplication>();
    const fresh = await makePlan(context, { rows: await seeded(context), ...asDeclared });
    const { rows } = await declareTo(context, stop, applications);
    const { plan } = await Effect.runPromise(readRepair(repairOn(context, rows, applications)));
    assert.equal(plan.action, "forget");
    const placeholder = structuredClone(rows.RouteGateway);
    const applied = await Effect.runPromise(
      applyRepair({ ...repairOn(context, rows, applications), digest: repairDigest(plan) }),
    );
    assert.equal(rows.RouteGateway, undefined);
    // The run keeps the row it removed, so a wrong repair can be put back.
    assert.deepEqual(applied.before, placeholder);
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
  const applications = new Map<string, FakeApplication>();
  const { rows } = await declareTo(context, "commit-lost", applications);
  const [live] = [...applications.values()];
  assert.ok(live, "the create reached the account");
  const { plan } = await Effect.runPromise(readRepair(repairOn(context, rows, applications)));
  assert.deepEqual(plan.action === "adopt" ? [plan.application, plan.namespace] : plan.action, [
    live.id,
    "namespace-route-gateway",
  ]);
  await Effect.runPromise(
    applyRepair({ ...repairOn(context, rows, applications), digest: repairDigest(plan) }),
  );
  // The next release reads the row as the live application, exactly as it reads a declare that
  // finished: every policy plans the gateway's row and judges the plan the same way. Neither ever
  // creates an application beside it, nor replaces or deletes it.
  const done = new Map<string, FakeApplication>();
  const finished = await declareTo(context, "finished", done);
  for (const name of await policies()) {
    const adopted = await planAs(context, rows, name, applications);
    const reference = await planAs(context, finished.rows, name, done);
    assert.ok(Exit.isSuccess(adopted) && Exit.isSuccess(reference), `${name} plans both`);
    const row = action(adopted.value.plan, "RouteGateway");
    assert.equal(row, action(reference.value.plan, "RouteGateway"), name);
    assert.ok(row === "noop" || row === "update" || row === "absent", `${name}: ${row}`);
    assert.deepEqual(
      await verdict(adopted.value.plan, name),
      await verdict(reference.value.plan, name),
      name,
    );
  }
});

test("the repair touches nothing but a placeholder it can account for", async (context) => {
  const refused = async (rows: Rows, applications: Map<string, FakeApplication>) => {
    const before = structuredClone(rows);
    const exit = await Effect.runPromiseExit(readRepair(repairOn(context, rows, applications)));
    assert.ok(Exit.isFailure(exit), "the repair planned");
    const error = Cause.squash(exit.cause);
    assert.ok(error instanceof RepairRefused, String(error));
    assert.deepEqual(rows, before, "a refused repair changed nothing");
    return error.why;
  };
  // A finished declare records the live application: nothing to repair.
  const done = new Map<string, FakeApplication>();
  const finished = await declareTo(context, "finished", done);
  assert.match(await refused(finished.rows, done), /live application/u);

  const applications = new Map<string, FakeApplication>();
  const { rows } = await declareTo(context, "commit-lost", applications);
  const [live] = [...applications.values()];
  const withRow = (change: object) =>
    ({ ...rows, RouteGateway: { ...rows.RouteGateway!, ...change } }) as Rows;
  // One attached to another namespace than the Worker records is not the row's.
  const elsewhere = new Map([[live!.id, { ...live!, namespaceId: "other" }]]);
  assert.match(await refused(rows, elsewhere), /another namespace/u);
  // A Worker that records no namespace for the class cannot say whose the application is.
  const pool = rows.PoolWorker as unknown as { attr: { durableObjectNamespaces: object } };
  const unhosted = {
    ...rows,
    PoolWorker: { ...rows.PoolWorker!, attr: { ...pool.attr, durableObjectNamespaces: {} } },
  } as Rows;
  assert.match(await refused(unhosted, applications), /records no namespace/u);
  // An interrupted replace keeps the live generation under `old`, and a create, update or delete
  // in flight is Alchemy's deploy's to finish: forgetting any of them would orphan what it records.
  const generation = { ...rows.RouteGateway!, attr: { applicationId: live!.id } };
  for (const change of [
    { status: "replacing", old: generation },
    { status: "creating" },
    { status: "updating", old: generation },
    { status: "deleting" },
  ])
    assert.match(
      await refused(withRow(change), new Map()),
      /not a finished first create/u,
      change.status,
    );
  assert.match(await refused(withRow({ old: generation }), new Map()), /older generation/u);
  // A row written in local mode, or with a generated name, is not one the repair can account for.
  assert.match(await refused(withRow({ providerMode: "local" }), applications), /local mode/u);
  const generated = withRow({
    props: { ...(rows.RouteGateway!.props as object), name: undefined },
  });
  assert.match(await refused(generated, applications), /explicitly named/u);

  // An approved repair is applied only while it is still the repair the reviewer saw.
  const { plan } = await Effect.runPromise(readRepair(repairOn(context, rows, applications)));
  const before = structuredClone(rows);
  const stale = await Effect.runPromiseExit(
    applyRepair({ ...repairOn(context, rows, new Map()), digest: repairDigest(plan) }),
  );
  assert.ok(Exit.isFailure(stale) && Cause.squash(stale.cause) instanceof RepairRefused);
  assert.deepEqual(rows, before, "a refused repair changed nothing");
});

test("a declared gateway does not block the fleet's class change, and only the allowance admits its attachment", async (context) => {
  const applications = new Map<string, FakeApplication>();
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
  const applications = new Map<string, FakeApplication>();
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

test("the allowance takes only a settled row of the gateway", async (context) => {
  const applications = new Map<string, FakeApplication>();
  const { rows } = await declareTo(context, "finished", applications);
  for (const status of ["replaced", "replacing", "creating", "updating"]) {
    const exit = await planAs(context, rows, "cutover-classes", applications);
    assert.ok(Exit.isSuccess(exit));
    const node = exit.value.plan.resources.RouteGateway as unknown as { state: { status: string } };
    // The plan as an unsettled row would give it; Alchemy's own planner refuses most of these
    // under the cutover's selection, so the allowance has to as well.
    node.state = { ...node.state, status };
    assert.ok(
      (await verdict(exit.value.plan, "cutover-classes")).includes(
        "outside-cutover-classes RouteGateway update",
      ),
      status,
    );
  }
});

test("a declaration is the recorded one only with the same props and the same build context", () => {
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  const here = join(checkout, "containers", "route-gateway");
  const props = { name: "basalt-production-route-gateway", className: "RouteGateway" };
  assert.ok(sameDeclaration({ ...props, context: here }, { ...props, context: here }));
  // The same context under the checkout of the release that declared it.
  assert.ok(
    sameDeclaration(
      { ...props, context: "/elsewhere/basalt/containers/route-gateway" },
      { ...props, context: here },
    ),
  );
  for (const recorded of [
    { ...props, context: "/elsewhere/basalt/containers/pool" },
    { ...props },
    { ...props, context: here, instanceType: "standard" },
    { ...props, context: here, image: "registry.cloudflare.com/account/route-gateway@sha256:aa" },
    { ...props, context: here, name: "basalt-production-another" },
  ])
    assert.equal(
      sameDeclaration(recorded, { ...props, context: here }),
      false,
      JSON.stringify(recorded),
    );
  assert.equal(sameDeclaration({ ...props, context: here }, { ...props }), false);
});

test("a policy admitting a container's attachment without holding it does not decode", async () => {
  const raw = JSON.parse(
    await readFile(new URL("./policies/cutover-classes.json", import.meta.url), "utf8"),
  ) as { wire: Record<string, unknown> };
  const { heldApplications: _held, ...wire } = raw.wire;
  assert.throws(() => decodeReleasePolicy({ ...raw, wire }), /without wire.heldApplications/u);
});
