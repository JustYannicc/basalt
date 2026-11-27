import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResourceState } from "alchemy/State/ResourceState";
import { Cause, Data, Effect, Exit } from "effect";
import {
  applyRepair,
  type Observation,
  observeRow,
  planRepair,
  ProviderReadFailed,
  readRepair,
  RepairRefused,
  repairDigest,
  type RepairPlan,
  RepairStepFailed,
  runRepair,
} from "./placeholder-repair.ts";
import { StateStoreRefused } from "./stack-config.ts";

const ACCOUNT = "a".repeat(32);
/** A row a stopped declare leaves: created, live, explicitly named, holding precreate's id. */
const placeholder = (change: object = {}) => ({
  resourceType: "Cloudflare.Container",
  status: "created",
  providerMode: "live",
  instanceId: "instance-1",
  logicalId: "RouteGateway",
  props: { name: "gateway", className: "RouteGateway" },
  attr: { applicationId: "dev:precreated", applicationName: "gateway", accountId: ACCOUNT },
  bindings: [{ sid: "RouteGateway", data: { durableObjects: {} } }],
  ...change,
});
const live = (change: object = {}) => ({
  applicationId: "application-1",
  applicationName: "gateway",
  accountId: ACCOUNT,
  durableObjects: { namespaceId: "namespace-1" },
  ...change,
});
const hosted = () => "namespace-1";
const plan = (row: unknown, observed: Observation | undefined, account = ACCOUNT) =>
  planRepair({ fqn: "RouteGateway", account, row, hostedNamespace: hosted, observed });
const why = (result: RepairPlan | RepairRefused) => {
  assert.ok(result instanceof RepairRefused, `planned ${JSON.stringify(result)}`);
  return result.why;
};

test("only a finished first create holding a placeholder is repaired, by what the account holds", () => {
  assert.equal((plan(placeholder(), { status: "missing" }) as RepairPlan).action, "forget");
  assert.deepEqual(plan(placeholder(), { status: "drifted", actual: live() }), {
    fqn: "RouteGateway",
    action: "adopt",
    placeholder: "dev:precreated",
    name: "gateway",
    accountId: ACCOUNT,
    application: "application-1",
    namespace: "namespace-1",
  });
  // Every other shape a stopped apply can leave is the deploy's to finish, or not a placeholder.
  for (const status of ["creating", "updating", "updated", "replacing", "replaced", "deleting"])
    assert.match(
      why(plan(placeholder({ status }), { status: "missing" })),
      /finished first create/u,
      status,
    );
  for (const extra of [
    { old: placeholder() },
    { deleteFirst: false },
    { deleteFirst: true },
    { adopting: true },
  ])
    assert.match(
      why(plan(placeholder(extra), { status: "missing" })),
      /older generation/u,
      JSON.stringify(extra),
    );
  assert.match(
    why(plan(placeholder({ providerMode: "local" }), { status: "missing" })),
    /local mode/u,
  );
  assert.match(
    why(plan(placeholder({ props: { className: "RouteGateway" } }), { status: "missing" })),
    /explicitly named/u,
  );
  assert.match(
    why(
      plan(placeholder({ attr: { ...placeholder().attr, applicationId: "application-1" } }), {
        status: "missing",
      }),
    ),
    /live application/u,
  );
});

test("the repair touches only a row of the account it reads, and only an application that is the row's", () => {
  // The provider reads the run's account; a row of another would read as missing there.
  assert.match(why(plan(placeholder(), { status: "missing" }, "b".repeat(32))), /another account/u);
  // Nothing read is never "nothing there".
  assert.match(why(plan(placeholder(), undefined)), /did not read/u);
  assert.match(why(plan(placeholder(), { status: "in-sync" })), /in sync/u);
  for (const [change, reason] of [
    [{ accountId: "b".repeat(32) }, /not the row's/u],
    [{ applicationName: "another" }, /not the row's/u],
    [{ applicationId: "dev:another" }, /not the row's/u],
    [{ durableObjects: { namespaceId: "namespace-2" } }, /another namespace/u],
  ] as const)
    assert.match(why(plan(placeholder(), { status: "drifted", actual: live(change) })), reason);
  assert.match(
    why(
      planRepair({
        fqn: "RouteGateway",
        account: ACCOUNT,
        row: placeholder(),
        hostedNamespace: () => undefined,
        observed: { status: "drifted", actual: live() },
      }),
    ),
    /records no namespace/u,
  );
});

test("the digest binds every identity a reviewer approves", () => {
  const adopt = plan(placeholder(), { status: "drifted", actual: live() }) as Extract<
    RepairPlan,
    { action: "adopt" }
  >;
  const digest = repairDigest(adopt);
  for (const field of [
    "fqn",
    "placeholder",
    "name",
    "accountId",
    "application",
    "namespace",
  ] as const)
    assert.notEqual(repairDigest({ ...adopt, [field]: "changed" }), digest, field);
  assert.notEqual(repairDigest({ ...adopt, action: "forget" } as RepairPlan), digest);
});

/** A State store over one map, recording every write. */
const memory = (rows: Record<string, unknown>) => {
  const writes: string[] = [];
  const reads: string[] = [];
  return {
    writes,
    reads,
    store: {
      get: (fqn: string) => Effect.sync(() => (reads.push(fqn), structuredClone(rows[fqn]))),
      set: (fqn: string, value: unknown) =>
        Effect.sync(() => {
          writes.push(`set ${fqn}`);
          rows[fqn] = value;
        }),
      delete: (fqn: string) =>
        Effect.sync(() => {
          writes.push(`delete ${fqn}`);
          delete rows[fqn];
        }),
    },
  };
};
const worker = { attr: { durableObjectNamespaces: { RouteGateway: "namespace-1" } } };
const input = (
  store: ReturnType<typeof memory>["store"],
  observe: (fqn: string) => Effect.Effect<Observation | undefined, unknown>,
) => ({ fqn: "RouteGateway", account: ACCOUNT, worker: "PoolWorker", store, observe });

class ReadBroke extends Data.TaggedError("ReadBroke") {}

test("a failed account read stops the repair and writes nothing", async () => {
  const rows = { RouteGateway: placeholder(), PoolWorker: worker };
  const state = memory(rows);
  const exit = await Effect.runPromiseExit(
    readRepair(input(state.store, () => Effect.fail(new ReadBroke()))),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.squash(exit.cause);
  assert.ok(error instanceof RepairStepFailed && error.check === "read the account", String(error));
  assert.deepEqual(state.writes, []);
});

test("a row changed after the repair was planned is left alone", async () => {
  const rows: Record<string, unknown> = { RouteGateway: placeholder(), PoolWorker: worker };
  const state = memory(rows);
  const observe = () => Effect.succeed<Observation>({ status: "missing" });
  const { plan: planned } = await Effect.runPromise(readRepair(input(state.store, observe)));
  // A running apply commits the live row between the plan's reads and the write.
  let reads = 0;
  const racing = {
    ...state.store,
    get: (fqn: string) =>
      Effect.sync(() => {
        if (fqn === "RouteGateway" && ++reads === 2)
          rows.RouteGateway = placeholder({
            attr: { ...placeholder().attr, applicationId: "application-1" },
          });
        return structuredClone(rows[fqn]);
      }),
  };
  const exit = await Effect.runPromiseExit(
    applyRepair({ ...input(racing, observe), digest: repairDigest(planned) }),
  );
  assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof RepairRefused);
  assert.match(
    (Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as RepairRefused).why,
    /changed/u,
  );
  assert.deepEqual(state.writes, []);
});

test("the command holds the store to the release's contract, and seals the row a write replaces", async () => {
  const contract = (version: number) => ({
    id: "http",
    version: Effect.succeed(version),
    state: "shared" as const,
    stage: "production",
    runnerLocal: 1,
  });
  // A store at another contract version refuses before anything is read.
  {
    const state = memory({ RouteGateway: placeholder(), PoolWorker: worker });
    const exit = await Effect.runPromiseExit(
      runRepair({
        ...input(state.store, () => Effect.succeed<Observation>({ status: "missing" })),
        digest: undefined,
        contract: contract(7),
      }),
    );
    assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof StateStoreRefused);
    assert.deepEqual([state.reads, state.writes], [[], []]);
  }
  const observe = () => Effect.succeed<Observation>({ status: "missing" });
  // Without a digest the command only plans.
  const rows = { RouteGateway: placeholder(), PoolWorker: worker };
  const state = memory(rows);
  const planned = await Effect.runPromise(
    runRepair({ ...input(state.store, observe), digest: undefined, contract: contract(8) }),
  );
  assert.deepEqual(state.writes, []);
  assert.equal(planned.before, undefined);
  // With the approved digest it writes, and the sealed record keeps the row it removed.
  const applied = await Effect.runPromise(
    runRepair({
      ...input(state.store, observe),
      digest: repairDigest(planned.plan),
      contract: contract(8),
    }),
  );
  assert.deepEqual(state.writes, ["delete RouteGateway"]);
  assert.deepEqual(JSON.parse(applied.sealed).before, placeholder());
});

test("the provider's read: a row without one reads nothing, and any failure is the repair's own", async () => {
  const row = placeholder() as unknown as ResourceState;
  const withRead = (read: unknown) => (() => Effect.succeed({ read })) as never;
  assert.equal(
    await Effect.runPromise(observeRow("RouteGateway", row, withRead(undefined))),
    undefined,
  );
  assert.deepEqual(
    await Effect.runPromise(
      observeRow(
        "RouteGateway",
        row,
        withRead(() => Effect.void),
      ),
    ),
    { status: "missing" },
  );
  assert.deepEqual(
    await Effect.runPromise(
      observeRow(
        "RouteGateway",
        row,
        withRead(() => Effect.succeed(live())),
      ),
    ),
    { status: "drifted", actual: live() },
  );
  // The pin types the read's error `any`: an untagged failure still arrives as the repair's own.
  for (const failure of [new Error("plain"), "a string", null]) {
    const exit = await Effect.runPromiseExit(
      observeRow(
        "RouteGateway",
        row,
        withRead(() => Effect.fail(failure)),
      ),
    );
    assert.ok(
      Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ProviderReadFailed,
      String(failure),
    );
  }
});
