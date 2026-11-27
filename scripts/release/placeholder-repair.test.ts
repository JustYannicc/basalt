import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ResourceState } from "alchemy/State/ResourceState";
import { Cause, Context, Data, Effect, Exit } from "effect";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import {
  applyRepair,
  observeRecorded,
  repairCommand,
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
import { recordedApplicationOf, stageRowsOf, wireConfigFor } from "./wire-config.ts";

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
/** The read as observeRow reports it: the account it listed beside what it found. */
const plan = (row: unknown, observed: Observation | undefined, account = ACCOUNT) =>
  planRepair({
    fqn: "RouteGateway",
    row,
    hostedNamespace: hosted,
    observed: observed && { account, ...observed },
  });
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
  // The provider lists the session's account; a row of another would read as missing there.
  assert.match(
    why(plan(placeholder(), { status: "missing" }, "b".repeat(32))),
    /not the one the row records/u,
  );
  assert.match(
    why(plan(placeholder(), { status: "missing", account: undefined })),
    /not the one the row records/u,
  );
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
        row: placeholder(),
        hostedNamespace: () => undefined,
        observed: { status: "drifted", actual: live(), account: ACCOUNT },
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
) => ({ fqn: "RouteGateway", worker: "PoolWorker", store, observe });

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
  const observe = () => Effect.succeed<Observation>({ status: "missing", account: ACCOUNT });
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
        ...input(state.store, () =>
          Effect.succeed<Observation>({ status: "missing", account: ACCOUNT }),
        ),
        digest: undefined,
        contract: contract(7),
      }),
    );
    assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof StateStoreRefused);
    assert.deepEqual([state.reads, state.writes], [[], []]);
  }
  const observe = () => Effect.succeed<Observation>({ status: "missing", account: ACCOUNT });
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
    { status: "missing", account: undefined },
  );
  assert.deepEqual(
    await Effect.runPromise(
      observeRow(
        "RouteGateway",
        row,
        withRead(() => Effect.succeed(live())),
      ),
    ),
    { status: "drifted", actual: live(), account: undefined },
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

test("the read reports the account the session's Cloudflare environment lists", async () => {
  const row = placeholder() as unknown as ResourceState;
  const read = (() => Effect.succeed({ read: () => Effect.void })) as never;
  const observed = await Effect.runPromise(
    observeRow("RouteGateway", row, read).pipe(
      Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: ACCOUNT } as never)),
    ),
  );
  assert.deepEqual(observed, { status: "missing", account: ACCOUNT });
  // The account is the environment's, whatever the row records.
  const other = await Effect.runPromise(
    observeRow("RouteGateway", row, read).pipe(
      Effect.provideService(
        CloudflareEnvironment,
        Effect.succeed({ accountId: "b".repeat(32) } as never),
      ),
    ),
  );
  assert.equal(other?.account, "b".repeat(32));
});

test("the entry's account read never turns a failure into nothing there", async () => {
  const state = memory({ RouteGateway: placeholder() });
  const session = Effect.succeed({ context: Context.empty() });
  // No row: nothing to read, and the session is not opened.
  assert.equal(
    await Effect.runPromise(
      observeRecorded(state.store, Effect.die("never opened"), observeRow)("Absent"),
    ),
    undefined,
  );
  // A session that will not open, and a provider read that fails: both are the repair's failure.
  const finds = (() =>
    Effect.succeed({ status: "missing", account: ACCOUNT })) as unknown as typeof observeRow;
  const breaks = (() => Effect.fail(new ReadBroke())) as unknown as typeof observeRow;
  const unopened = await Effect.runPromiseExit(
    observeRecorded(state.store, Effect.fail(new ReadBroke()), finds)("RouteGateway"),
  );
  assert.ok(Exit.isFailure(unopened) && Cause.squash(unopened.cause) instanceof ReadBroke);
  const failed = await Effect.runPromiseExit(
    observeRecorded(state.store, session, breaks)("RouteGateway"),
  );
  assert.ok(Exit.isFailure(failed) && Cause.squash(failed.cause) instanceof ReadBroke);
});

test("a row is the one planned from only if its status, instance and application all match", async () => {
  const observe = () => Effect.succeed<Observation>({ status: "missing", account: ACCOUNT });
  for (const [label, start, moved] of [
    ["a new instance", placeholder(), placeholder({ instanceId: "instance-2" })],
    // A row with a part missing is never taken for the one planned from.
    [
      "no instance on either read",
      placeholder({ instanceId: undefined }),
      placeholder({ instanceId: undefined }),
    ],
  ] as const) {
    const rows: Record<string, unknown> = { RouteGateway: start, PoolWorker: worker };
    const state = memory(rows);
    const planned = await Effect.runPromiseExit(readRepair(input(state.store, observe)));
    if (Exit.isFailure(planned)) continue;
    let reads = 0;
    const racing = {
      ...state.store,
      get: (fqn: string) =>
        Effect.sync(() => {
          if (fqn === "RouteGateway" && ++reads === 2) rows.RouteGateway = moved;
          return structuredClone(rows[fqn]);
        }),
    };
    const exit = await Effect.runPromiseExit(
      applyRepair({ ...input(racing, observe), digest: repairDigest(planned.value.plan) }),
    );
    assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof RepairRefused, label);
    assert.deepEqual(state.writes, [], label);
  }
});

test("a row a running apply moved on is never repaired, even with its id unchanged", async () => {
  // Alchemy's promote of a placeholder commits `updating` with the same instance and attributes.
  const rows: Record<string, unknown> = { RouteGateway: placeholder(), PoolWorker: worker };
  const state = memory(rows);
  const observe = () => Effect.succeed<Observation>({ status: "missing", account: ACCOUNT });
  const { plan: planned } = await Effect.runPromise(readRepair(input(state.store, observe)));
  let reads = 0;
  const racing = {
    ...state.store,
    get: (fqn: string) =>
      Effect.sync(() => {
        if (fqn === "RouteGateway" && ++reads === 2)
          rows.RouteGateway = placeholder({ status: "updating" });
        return structuredClone(rows[fqn]);
      }),
  };
  const exit = await Effect.runPromiseExit(
    applyRepair({ ...input(racing, observe), digest: repairDigest(planned) }),
  );
  assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof RepairRefused);
  assert.deepEqual(state.writes, []);
});

test("an application another row records is never adopted for this one", async () => {
  for (const root of [
    {
      attr: { applicationId: "application-1", applicationName: "basalt-production-poolcontainer" },
    },
    { attr: { applicationId: "root-live", applicationName: "GATEWAY" } },
  ]) {
    const state = memory({ RouteGateway: placeholder(), PoolWorker: worker, PoolContainer: root });
    const observe = () =>
      Effect.succeed<Observation>({ status: "drifted", actual: live(), account: ACCOUNT });
    const exit = await Effect.runPromiseExit(
      readRepair({ ...input(state.store, observe), reserved: ["PoolContainer", "RouteGateway"] }),
    );
    assert.ok(Exit.isFailure(exit), JSON.stringify(root));
    assert.match((Cause.squash(exit.cause) as RepairRefused).why, /another row records/u);
  }
});

test("the command holds the store to the contract before an apply too, and keys State by its stage", async () => {
  const rows: Record<string, unknown> = { RouteGateway: placeholder(), PoolWorker: worker };
  const keys: string[] = [];
  const stageStore = (version: number) => ({
    id: "http",
    getVersion: () => Effect.succeed(version),
    get: (key: { stack: string; stage: string; fqn: string }) =>
      Effect.sync(
        () => (
          keys.push(`get ${key.stack}/${key.stage}/${key.fqn}`),
          structuredClone(rows[key.fqn])
        ),
      ),
    set: (key: { stack: string; stage: string; fqn: string }) =>
      Effect.sync(() => void keys.push(`set ${key.fqn}`)),
    delete: (key: { stack: string; stage: string; fqn: string }) =>
      Effect.sync(() => {
        keys.push(`delete ${key.stack}/${key.stage}/${key.fqn}`);
        delete rows[key.fqn];
      }),
  });
  const command = (version: number, digest: string | undefined) =>
    repairCommand({
      fqn: "RouteGateway",
      digest,
      policy: undefined,
      stage: stageRowsOf(stageStore(version), "basalt", "production"),
      stackState: "shared",
      runnerLocal: 1,
      open: Effect.succeed({ context: Context.empty() }),
    });
  // The command reads the row and its Worker under the stage's keys. With no provider in the
  // session the read itself cannot happen, and nothing is written.
  const planned = await Effect.runPromiseExit(command(8, undefined));
  assert.ok(Exit.isFailure(planned));
  assert.deepEqual(keys, [
    "get basalt/production/RouteGateway",
    "get basalt/production/PoolWorker",
    "get basalt/production/RouteGateway",
  ]);
  // A store at another contract version refuses an apply before anything is read.
  keys.length = 0;
  const exit = await Effect.runPromiseExit(command(7, "f".repeat(64)));
  assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof StateStoreRefused);
  assert.deepEqual(keys, []);
  // A runner-local stack is held to its own contract: a shared store refuses it.
  const local = await Effect.runPromiseExit(
    repairCommand({
      fqn: "RouteGateway",
      digest: undefined,
      policy: { worker: "PoolWorker", root: "Absent", held: [] },
      stage: stageRowsOf(stageStore(8), "basalt", "test-route-scratch-1"),
      stackState: "runner-local",
      runnerLocal: 1,
      open: Effect.succeed({ context: Context.empty() }),
    }),
  );
  assert.ok(Exit.isFailure(local) && Cause.squash(local.cause) instanceof StateStoreRefused);
  // Through the command, an approved forget deletes the row itself, under the stage's key.
  keys.length = 0;
  const finds = (() =>
    Effect.succeed({ status: "missing", account: ACCOUNT })) as unknown as typeof observeRow;
  const via = (digest: string | undefined) =>
    repairCommand({
      fqn: "RouteGateway",
      digest,
      policy: undefined,
      stage: stageRowsOf(stageStore(8), "basalt", "production"),
      stackState: "shared",
      runnerLocal: 1,
      open: Effect.succeed({ context: Context.empty() }),
      read: finds,
    });
  const first = await Effect.runPromise(via(undefined));
  await Effect.runPromise(via(repairDigest(first.plan)));
  assert.deepEqual(
    keys.map(String).filter((key) => !key.startsWith("get")),
    ["delete basalt/production/RouteGateway"],
  );
});

test("the entry hands the repair and the holds exactly what the release decided", async () => {
  // deploy.ts is a script, not a module; what it passes is pinned here. Comments are stripped
  // first, so text kept in a comment pins nothing.
  const source = await readFile(new URL("./deploy.ts", import.meta.url), "utf8");
  const entry = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:"'`])\/\/.*$/gmu, "$1")
    .replace(/\s+/gu, " ");
  for (const wiring of [
    'readOnly: readOnlyRun(stage, command, values["plan-digest"])',
    "return stageRowsOf(state, yield* stackName(), stage); }).pipe(Effect.mapError(",
    "stageState.pipe( Effect.flatMap((rows) => rows.row(fqn)),",
    "const records = yield* stageState.pipe(Effect.orDie); const holds = yield* wireConfigFor({ stage, policy: policy?.check && { rootFqn: policy.check.poolContainer.fqn, held: policy.wire.heldApplications ?? [], }, recorded: records.application, }).pipe(Effect.orDie); const { unnamedRoot, ...applied } = holds; Object.freeze(Object.assign(wire, applied));",
    'const digest = values["plan-digest"];',
    "const records = yield* stageState; return yield* repair.repairCommand({ fqn, digest, policy: policy && { worker: policy.check.poolWorker, root: policy.check.poolContainer.fqn, held: policy.wire.heldApplications ?? [], }, stage: records, stackState, runnerLocal: runnerLocalStateVersion, open: Effect.suspend(() => Session.open(target as never)).pipe( Effect.mapError((cause) => new StateReadFailed({ fqn, cause })), ), }); }), );",
    'await keepPrivate("repair", result.sealed);',
  ])
    assert.ok(entry.includes(wiring), wiring);
  // One of each, and nothing else writes the holds after them.
  const count = (text: string) => entry.split(text).length - 1;
  assert.equal(count("wireConfigFor("), 1);
  // One reader of the stage's rows, and every row the holds or a repair touch comes from it.
  assert.equal(count("stageRowsOf("), 1);
  assert.equal(count("yield* stageState"), 2);
  assert.equal(count("recorded: records.application"), 1);
  assert.equal(count("repair.repairCommand("), 1);
  assert.equal(count("Object.assign(wire"), 1);
  // The guard's own config (`wire`), not a policy's `wire` section, is never written field by field.
  for (const field of [
    "rootApplications",
    "rootApplicationNames",
    "heldApplications",
    "rootRequired",
  ])
    assert.equal(
      entry.match(new RegExp(`(?<![.?])\\bwire\\.${field}\\b`, "gu"))?.length ?? 0,
      0,
      field,
    );
});

/** A stage's store over one map, recording every write with its full key. */
const stageMap = (rows: Record<string, unknown>, id = "http", version = 8) => {
  const writes: string[] = [];
  const key = (at: { stack: string; stage: string; fqn: string }) =>
    `${at.stack}/${at.stage}/${at.fqn}`;
  return {
    writes,
    store: {
      id,
      getVersion: () => Effect.succeed(version),
      get: (at: { stack: string; stage: string; fqn: string }) =>
        Effect.sync(() =>
          at.stage === "test-route-scratch-1" ? structuredClone(rows[at.fqn]) : undefined,
        ),
      set: (at: { stack: string; stage: string; fqn: string; value: never }) =>
        Effect.sync(() => {
          writes.push(`set ${key(at)}`);
          rows[at.fqn] = at.value;
        }),
      delete: (at: { stack: string; stage: string; fqn: string }) =>
        Effect.sync(() => {
          writes.push(`delete ${key(at)}`);
          delete rows[at.fqn];
        }),
    },
  };
};
const scratch = { stack: "basalt", stage: "test-route-scratch-1" };
/** Plans, then applies the approved digest, through the command as the entry runs it. */
const commandRun = async (
  rows: Record<string, unknown>,
  read: Observation,
  policy: { worker: string; root: string; held: string[] } | undefined,
  contract: {
    id?: string;
    version?: number;
    stackState?: "shared" | "runner-local";
    runnerLocal?: number;
  } = {},
) => {
  const stage = stageMap(rows, contract.id, contract.version);
  const via = (digest: string | undefined) =>
    repairCommand({
      fqn: "RouteGateway",
      digest,
      policy,
      stage: stageRowsOf(stage.store, scratch.stack, scratch.stage),
      stackState: contract.stackState ?? "shared",
      runnerLocal: contract.runnerLocal ?? 1,
      open: Effect.succeed({ context: Context.empty() }),
      read: (() => Effect.succeed(read)) as unknown as typeof observeRow,
    });
  const planned = await Effect.runPromiseExit(via(undefined));
  if (Exit.isFailure(planned)) return { planned, writes: stage.writes };
  await Effect.runPromise(via(repairDigest(planned.value.plan)));
  return { planned, writes: stage.writes };
};

test("through the command, a repair writes only the gateway's own row, under the stage it runs on", async () => {
  const drifted = { status: "drifted" as const, actual: live(), account: ACCOUNT };
  const missing = { status: "missing" as const, account: ACCOUNT };
  const policy = { worker: "PoolWorker", root: "PoolContainer", held: ["RouteGateway"] };
  // An adopt: the gateway's row alone is set, and the policy's own held fqn is not "another row".
  const adopt = await commandRun(
    { RouteGateway: placeholder(), PoolWorker: worker },
    drifted,
    policy,
  );
  assert.deepEqual(adopt.writes, ["set basalt/test-route-scratch-1/RouteGateway"]);
  // A forget: the gateway's row alone is deleted.
  const forget = await commandRun(
    { RouteGateway: placeholder(), PoolWorker: worker },
    missing,
    undefined,
  );
  assert.deepEqual(forget.writes, ["delete basalt/test-route-scratch-1/RouteGateway"]);
  // The policy's root, whatever its fqn, is never adopted for the gateway, in any case.
  for (const recorded of ["application-1", "APPLICATION-1"]) {
    const taken = await commandRun(
      {
        RouteGateway: placeholder(),
        PoolWorker: worker,
        Root: { attr: { applicationId: recorded, applicationName: "root" } },
      },
      drifted,
      { worker: "PoolWorker", root: "Root", held: [] },
    );
    assert.ok(Exit.isFailure(taken.planned), recorded);
    assert.match((Cause.squash(taken.planned.cause) as RepairRefused).why, /another row records/u);
    assert.deepEqual(taken.writes, []);
  }
  // The namespace is read from the policy's own pool Worker.
  const elsewhere = await commandRun(
    { RouteGateway: placeholder(), OtherWorker: worker },
    drifted,
    { worker: "OtherWorker", root: "PoolContainer", held: [] },
  );
  assert.deepEqual(elsewhere.writes, ["set basalt/test-route-scratch-1/RouteGateway"]);
  // A runner-local stack's store is judged by its id, its stage and its own version.
  const local = await commandRun(
    { RouteGateway: placeholder(), PoolWorker: worker },
    missing,
    undefined,
    {
      id: "local",
      version: 3,
      stackState: "runner-local",
      runnerLocal: 3,
    },
  );
  assert.deepEqual(local.writes, ["delete basalt/test-route-scratch-1/RouteGateway"]);
  for (const contract of [
    { id: "http", version: 3, stackState: "runner-local" as const, runnerLocal: 3 },
    { id: "local", version: 4, stackState: "runner-local" as const, runnerLocal: 3 },
  ]) {
    const refused = await commandRun(
      { RouteGateway: placeholder(), PoolWorker: worker },
      missing,
      undefined,
      contract,
    );
    assert.ok(
      Exit.isFailure(refused.planned) &&
        Cause.squash(refused.planned.cause) instanceof StateStoreRefused,
    );
    assert.deepEqual(refused.writes, []);
  }
});

const refusedAsTaken = (result: Awaited<ReturnType<typeof commandRun>>, label: string) => {
  assert.ok(Exit.isFailure(result.planned), `${label}: planned ${JSON.stringify(result.planned)}`);
  assert.match((Cause.squash(result.planned.cause) as RepairRefused).why, /another row/u, label);
  assert.deepEqual(result.writes, [], label);
};

test("a repair run without a policy never adopts the default root's application", async () => {
  const drifted = { status: "drifted" as const, actual: live(), account: ACCOUNT };
  for (const root of [
    { attr: { applicationId: "APPLICATION-1", applicationName: "root" } },
    { attr: { applicationId: "root-live", applicationName: "GateWay" } },
  ])
    refusedAsTaken(
      await commandRun(
        { RouteGateway: placeholder(), PoolWorker: worker, PoolContainer: root },
        drifted,
        undefined,
      ),
      JSON.stringify(root),
    );
});

test("every held row is reserved, not only the first or the repaired one", async () => {
  const drifted = { status: "drifted" as const, actual: live(), account: ACCOUNT };
  const policy = { worker: "PoolWorker", root: "PoolContainer", held: ["RouteGateway", "Held"] };
  for (const held of [
    { attr: { applicationId: "APPLICATION-1", applicationName: "held" } },
    { attr: { applicationId: "held-live", applicationName: "Gateway" } },
  ])
    refusedAsTaken(
      await commandRun(
        { RouteGateway: placeholder(), PoolWorker: worker, Held: held },
        drifted,
        policy,
      ),
      JSON.stringify(held),
    );
  // The case is folded on both sides: an upper-case live id or a mixed-case row name.
  for (const [actual, row, reserved] of [
    [live({ applicationId: "APPLICATION-1" }), placeholder(), { applicationId: "application-1" }],
    [
      live({ applicationName: "GateWay" }),
      placeholder({
        props: { name: "GateWay", className: "RouteGateway" },
        attr: { applicationId: "dev:precreated", applicationName: "GateWay", accountId: ACCOUNT },
      }),
      { applicationId: "held-live", applicationName: "gateway" },
    ],
  ] as const)
    refusedAsTaken(
      await commandRun(
        { RouteGateway: row, PoolWorker: worker, Held: { attr: reserved } },
        { status: "drifted", actual, account: ACCOUNT },
        policy,
      ),
      JSON.stringify(reserved),
    );
  // Applications of their own leave a legitimate adopt alone.
  const own = await commandRun(
    {
      RouteGateway: placeholder(),
      PoolWorker: worker,
      PoolContainer: { attr: { applicationId: "root-live", applicationName: "root" } },
      Held: { attr: { applicationId: "held-live", applicationName: "held" } },
    },
    drifted,
    policy,
  );
  assert.deepEqual(own.writes, ["set basalt/test-route-scratch-1/RouteGateway"]);
});

test("a reserved row known by id alone stops an adopt, never a forget", async () => {
  // A legacy root: its id may be stale, so the live application under the name may be its own.
  for (const attr of [
    { applicationId: "stale-root" },
    { applicationId: "stale-root", applicationName: "" },
  ]) {
    const rows = () => ({
      RouteGateway: placeholder(),
      PoolWorker: worker,
      PoolContainer: { attr },
    });
    const drifted = { status: "drifted" as const, actual: live(), account: ACCOUNT };
    const adopt = await commandRun(rows(), drifted, undefined);
    assert.ok(Exit.isFailure(adopt.planned), JSON.stringify(attr));
    assert.match((Cause.squash(adopt.planned.cause) as RepairRefused).why, /by id alone/u);
    assert.deepEqual(adopt.writes, []);
    const forget = await commandRun(rows(), { status: "missing", account: ACCOUNT }, undefined);
    assert.deepEqual(forget.writes, ["delete basalt/test-route-scratch-1/RouteGateway"]);
  }
});

test("the stage's rows are read and written under the stack's key, each by its own fqn", async () => {
  const keys: string[] = [];
  const rows: Record<string, unknown> = {
    PoolContainer: { attr: { applicationId: "root-live", applicationName: "root" } },
    RouteGateway: { attr: { applicationId: "gateway-live", applicationName: "gateway" } },
  };
  const key = (at: { stack: string; stage: string; fqn: string }) =>
    `${at.stack}/${at.stage}/${at.fqn}`;
  const stage = stageRowsOf(
    {
      id: "http",
      getVersion: () => Effect.succeed(8),
      get: (at) => Effect.sync(() => (keys.push(`get ${key(at)}`), rows[at.fqn])),
      set: (at) => Effect.sync(() => void keys.push(`set ${key(at)}`)),
      delete: (at) => Effect.sync(() => void keys.push(`delete ${key(at)}`)),
    },
    "stack-1",
    "test-route-scratch-1",
  );
  assert.deepEqual(stage.at, { stack: "stack-1", stage: "test-route-scratch-1" });
  const read = await Effect.runPromise(
    Effect.all([
      stage.application("PoolContainer"),
      stage.application("RouteGateway"),
      stage.row("Absent"),
      stage.store.set("RouteGateway", {}),
      stage.store.delete("RouteGateway"),
    ]),
  );
  assert.deepEqual(read.slice(0, 3), [
    { id: "root-live", name: "root" },
    { id: "gateway-live", name: "gateway" },
    undefined,
  ]);
  assert.deepEqual(keys, [
    "get stack-1/test-route-scratch-1/PoolContainer",
    "get stack-1/test-route-scratch-1/RouteGateway",
    "get stack-1/test-route-scratch-1/Absent",
    "set stack-1/test-route-scratch-1/RouteGateway",
    "delete stack-1/test-route-scratch-1/RouteGateway",
  ]);
  // The holds the entry builds from them are the root's own, and nothing edits them afterwards.
  const holds = await Effect.runPromise(
    wireConfigFor({
      stage: "production",
      policy: { rootFqn: "PoolContainer", held: ["RouteGateway"] },
      recorded: stage.application,
    }),
  );
  assert.deepEqual(holds.rootApplications, ["root-live"]);
  assert.deepEqual(holds.rootApplicationNames, ["root"]);
  assert.deepEqual(holds.heldApplications, [{ id: "gateway-live", name: "gateway" }]);
  assert.ok(Object.isFrozen(holds.rootApplications) && Object.isFrozen(holds.rootApplicationNames));
  assert.ok(Object.isFrozen(holds.heldApplications) && Object.isFrozen(holds.heldApplications[0]));
});

test("a row's application is its id and the name it was created under, never the id twice", () => {
  assert.deepEqual(
    recordedApplicationOf({ attr: { applicationId: "application-1", applicationName: "gateway" } }),
    { id: "application-1", name: "gateway" },
  );
  assert.deepEqual(recordedApplicationOf({ attr: { applicationId: "application-1" } }), {
    id: "application-1",
    name: undefined,
  });
  for (const row of [
    undefined,
    {},
    { attr: { applicationId: "" } },
    { attr: { applicationName: "gateway" } },
  ])
    assert.equal(recordedApplicationOf(row), undefined, JSON.stringify(row));
});
