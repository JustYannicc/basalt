import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { homeTopologyPath } from "./runtime-crash-cell.ts";
import { crashAuditKey, crashNonceKey } from "./runtime-crash-contract.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";
import {
  answerTopology,
  documentedTopology,
  followerTopology,
  masterlessTopology,
} from "./test/home-topology.ts";
import { signEnvelope } from "./token.ts";

type Fleet = Awaited<ReturnType<typeof fleetWorkerFixture>>;

/** One ready cell beside the primary. The cell's Home answers its topology read with `topology`. */
async function ready(
  context: TestContext,
  topology: () => Response = () => Response.json(null),
  runtimeBindings?: Readonly<Record<string, string>>,
) {
  const f = await fleetWorkerFixture(runtimeBindings ? { runtimeBindings } : {});
  context.after(f.cleanup);
  const events: string[] = [];
  f.onRuntimeCreated(async (runtime) => {
    const container = runtime.ctx.container;
    const port = container.getTcpPort.bind(container);
    const signal = container.signal.bind(container);
    const health = runtime.hooks.health;
    runtime.hooks.health = async () => {
      events.push("health");
      await health();
    };
    container.signal = (number) => {
      events.push("signal");
      signal(number);
    };
    // A cell's Home listens on the peer port, which the shared fixture does not serve.
    container.getTcpPort = (number) =>
      number !== 8329
        ? port(number)
        : {
            fetch: async (input, init) => {
              const request = new Request(input, init);
              assert.equal(request.method, "GET");
              assert.equal(new URL(request.url).pathname, homeTopologyPath);
              assert.equal(
                request.headers.get("X-Management-Key"),
                runtime.env.POOL_MANAGEMENT_KEY,
              );
              events.push("topology");
              return topology();
            },
          };
  });
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "cell-crash-fleet",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const response = await f.model();
  assert.equal(response.status, 200);
  await response.body?.cancel();
  await f.settle();
  const [row] = await f.resourcesWhen((rows) => rows.some((value) => value.phase === "ready"));
  assert.ok(row?.identity);
  const cell = f.instances.get(row.target.instanceId)!.fixture;
  events.length = 0;
  const at = Date.now();
  const command = {
    kind: "cell" as const,
    identity: row.identity,
    nonce: crypto.randomUUID(),
    operator: "fixture-operator",
    at,
    expiresAt: at + 30_000,
  };
  return { f, cell, command, events };
}

async function crash(
  f: Fleet,
  command: { kind?: "cell"; identity: SlotIdentity; nonce: string; operator: string; at: number },
) {
  return f.worker.runtimeHandoff(
    new Request("http://operations/runtime-handoff", {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(f.old.env.POOL_DEPLOYMENT_KEY!, deploymentReadinessPrefix, {
          controllerCode: runtimeFixtureCode,
          action: "runtime-crash",
          ...command,
        }),
      }),
    }),
  );
}

const reason = (body: unknown) =>
  typeof body === "object" && body !== null && "reason" in body ? String(body.reason) : "";

function refusals(context: TestContext) {
  const warnings = context.mock.method(console, "warn", () => {});
  return () =>
    warnings.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.startsWith("POOL_CRASH_REFUSED "))
      .map((line) => JSON.parse(line.slice("POOL_CRASH_REFUSED ".length)).reason);
}

test(
  "a follower cell is killed inside its own runtime, audited and detected while requests keep succeeding",
  { timeout: 20_000 },
  async (context) => {
    const { f, cell, command, events } = await ready(context, () =>
      Response.json(followerTopology()),
    );
    const before = await f.inspect();
    const response = await crash(f, command);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(cell.calls.signals, [9]);
    assert.deepEqual(f.old.calls.signals, []);
    // The Home read is the last thing the cell does before it signals.
    assert.deepEqual(events.slice(-2), ["topology", "signal"]);
    assert.deepEqual(await f.inspect(), before, "a cell kill must not change the selection");
    const audit = await cell.storage.get<{ command: typeof command; status: string }>(
      crashAuditKey(command.nonce),
    );
    assert.equal(audit?.status, "signalled");
    assert.equal(audit?.command.kind, "cell");
    assert.equal(audit?.command.operator, command.operator);
    assert.equal(await f.old.storage.get(crashAuditKey(command.nonce)), undefined);
    const submission = await f.old.storage.get<{
      command: typeof command;
      sibling: SlotIdentity;
      status: string;
    }>(crashNonceKey(command.nonce));
    assert.equal(submission?.status, "returned");
    assert.equal(submission?.command.kind, "cell");
    assert.deepEqual(submission?.sibling, f.old.identity());
    assert.equal((await crash(f, command)).status, 409, "a consumed nonce cannot kill again");
    const inspected = await f.command("runtime-crash-inspect", {
      identity: command.identity,
      nonce: command.nonce,
    });
    assert.equal(inspected.status, 200);
    const body = (await inspected.json()) as {
      result: { target: { ready: boolean; audit: unknown } };
    };
    assert.equal(body.result.target.ready, false);
    assert.ok(body.result.target.audit);
    await f.upkeep();
    await f.settle();
    const rows = await new RuntimeFleetState(f.old.storage, 4).inspect();
    // Fenced by its first failed read, the killed boot takes no call; the 6 s rule then removes it.
    assert.ok(
      !rows.some(
        (row) =>
          row.phase === "ready" &&
          row.suspect === undefined &&
          row.identity?.bootId === command.identity.bootId,
      ),
      "supervision must stop routing to the killed boot",
    );
    const after = await f.model();
    assert.equal(after.status, 200);
    await after.body?.cancel();
    assert.deepEqual(cell.calls.signals, [9]);
  },
);

test("a cell command cannot name the selected primary", { timeout: 15_000 }, async (context) => {
  const { f, cell, command } = await ready(context, () => Response.json(followerTopology()));
  const response = await crash(f, { ...command, identity: f.old.identity() });
  assert.equal(response.status, 409);
  // The identity rule itself refuses, before any fleet row or runtime is consulted.
  assert.match(reason(await response.json()), /identity$/u);
  assert.deepEqual(f.old.calls.signals, []);
  assert.deepEqual(cell.calls.signals, []);
  assert.equal(await f.old.storage.get(crashNonceKey(command.nonce)), undefined);
});

test(
  "a cell that is draining or not the named boot is refused",
  { timeout: 15_000 },
  async (context) => {
    const { f, cell, command, events } = await ready(context, () =>
      Response.json(followerTopology()),
    );
    assert.equal(
      (await crash(f, { ...command, identity: { ...command.identity, bootId: "other-boot" } }))
        .status,
      409,
    );
    await new RuntimeFleetState(f.old.storage, 4).drain(command.identity);
    const draining = await crash(f, command);
    assert.equal(draining.status, 409);
    assert.match(reason(await draining.json()), /draining$/u);
    assert.deepEqual(cell.calls.signals, []);
    assert.ok(!events.includes("topology"), "a refused target is never asked about its Home");
    assert.equal(await f.old.storage.get(crashNonceKey(command.nonce)), undefined);
  },
);

test(
  "a cell is refused when neither the primary nor another cell serves",
  { timeout: 15_000 },
  async (context) => {
    const { f, cell, command } = await ready(context, () => Response.json(followerTopology()));
    f.old.crash();
    const response = await crash(f, command);
    assert.equal(response.status, 409);
    assert.match(reason(await response.json()), /unhealthy$/u);
    assert.deepEqual(cell.calls.signals, []);
    assert.equal(await cell.storage.get(crashAuditKey(command.nonce)), undefined);
  },
);

for (const [name, reply, reason] of [
  ["is the master", () => Response.json(documentedTopology), "master"],
  [
    "still reported itself master at its last heartbeat",
    () => {
      const topology = followerTopology();
      return Response.json({
        ...topology,
        homes: topology.homes.map((home) =>
          home.id === topology.management.home_id ? { ...home, reported_master: true } : home,
        ),
      });
    },
    "reported_master",
  ],
  ["has no master", () => Response.json(masterlessTopology()), "missing_master"],
  [
    "is absent from its own topology",
    () => {
      const topology = followerTopology();
      return Response.json({ ...topology, homes: topology.homes.slice(0, 1) });
    },
    "home_unknown",
  ],
  ["answers with an error", () => new Response(null, { status: 503 }), "topology_unreadable"],
  ["answers with another shape", () => Response.json({ homes: [] }), "topology_unreadable"],
  [
    "cannot be reached",
    () => {
      throw new Error("synthetic Home port closed");
    },
    "topology_unreadable",
  ],
] as const)
  test(`a cell whose Home ${name} is not killed`, { timeout: 15_000 }, async (context) => {
    const { f, cell, command } = await ready(context, reply);
    const reasons = refusals(context);
    context.mock.method(console, "error", () => {});
    const response = await crash(f, command);
    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(reasons(), [reason]);
    assert.deepEqual(cell.calls.signals, []);
    assert.deepEqual(f.old.calls.signals, []);
    assert.equal(cell.ctx.container.running, true);
    assert.equal(await cell.storage.get(crashAuditKey(command.nonce)), undefined);
  });

test(
  "a Home that becomes master while the audit is written is still not killed",
  { timeout: 15_000 },
  async (context) => {
    let reads = 0;
    const { f, cell, command } = await ready(context, () =>
      Response.json(++reads === 1 ? followerTopology() : documentedTopology),
    );
    const reasons = refusals(context);
    assert.equal((await crash(f, command)).status, 409);
    assert.deepEqual(reasons(), ["master"]);
    assert.deepEqual(cell.calls.signals, []);
    const audit = await cell.storage.get<{ status: string }>(crashAuditKey(command.nonce));
    assert.equal(audit?.status, "armed");
  },
);

/** The same packet without `kind`, naming the selected primary: the shape every primary kill has. */
function primaryOf(f: Fleet, command: Awaited<ReturnType<typeof ready>>["command"]) {
  const { kind: _kind, ...primary } = { ...command, identity: f.old.identity() };
  return primary;
}

// Production shape: the Worker carries no POOL_ALLOW_MASTER_CRASH binding.
for (const [name, reply, reason] of [
  ["is the master", () => Response.json(documentedTopology), "master"],
  ["has no master", () => Response.json(masterlessTopology()), "missing_master"],
  ["answers with an error", () => new Response(null, { status: 503 }), "topology_unreadable"],
  [
    "cannot be reached",
    () => {
      throw new Error("synthetic Home port closed");
    },
    "topology_unreadable",
  ],
] as const)
  test(
    `without the stage binding, the primary whose Home ${name} is not killed`,
    { timeout: 15_000 },
    async (context) => {
      const { f, cell, command } = await ready(context, () => Response.json(followerTopology()));
      answerTopology(f.old.home, reply);
      const reasons = refusals(context);
      context.mock.method(console, "error", () => {});
      const response = await crash(f, primaryOf(f, command));
      assert.equal(response.status, 409, await response.clone().text());
      assert.deepEqual(reasons(), [reason]);
      assert.deepEqual(f.old.calls.signals, []);
      assert.deepEqual(cell.calls.signals, []);
      assert.equal(f.old.ctx.container.running, true);
      assert.equal(await f.old.storage.get(crashAuditKey(command.nonce)), undefined);
    },
  );

test(
  "without the stage binding, the primary on a proven follower Home is killed, and the Home read is last",
  { timeout: 15_000 },
  async (context) => {
    const { f, cell, command } = await ready(context, () => Response.json(followerTopology()));
    const order: string[] = [];
    answerTopology(f.old.home, () => {
      order.push("topology");
      return Response.json(followerTopology());
    });
    const signal = f.old.ctx.container.signal;
    f.old.ctx.container.signal = (number) => {
      order.push("signal");
      signal(number);
    };
    const response = await crash(f, primaryOf(f, command));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(f.old.calls.signals, [9]);
    assert.deepEqual(cell.calls.signals, []);
    assert.deepEqual(order.slice(-2), ["topology", "signal"]);
    const submission = await f.old.storage.get<{ command: object }>(crashNonceKey(command.nonce));
    assert.ok(submission && !("kind" in submission.command));
  },
);

test(
  "only the exact stage binding lets the primary on a master Home be killed",
  { timeout: 20_000 },
  async (context) => {
    const { f, cell, command } = await ready(context, () => Response.json(followerTopology()));
    answerTopology(f.old.home, () => Response.json(documentedTopology));
    const reasons = refusals(context);
    for (const value of ["false", "1", "TRUE", ""]) {
      // A redeploy with that binding value: the controller is rebuilt over the same storage.
      f.advanceCurrentBindings({ POOL_ALLOW_MASTER_CRASH: value });
      const refused = await f.command("runtime-crash", {
        ...primaryOf(f, command),
        nonce: crypto.randomUUID(),
      });
      assert.equal(refused.status, 409, `binding ${JSON.stringify(value)} must not allow it`);
    }
    assert.deepEqual(reasons(), ["master", "master", "master", "master"]);
    assert.deepEqual(f.old.calls.signals, []);
    // A disposable stage that binds exactly this value (the declarations bind it on test-* stages).
    f.advanceCurrentBindings({ POOL_ALLOW_MASTER_CRASH: "true" });
    const response = await f.command("runtime-crash", primaryOf(f, command));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(f.old.calls.signals, [9]);
    assert.deepEqual(cell.calls.signals, []);
    const audit = await f.old.storage.get<{ status: string }>(crashAuditKey(command.nonce));
    assert.equal(audit?.status, "signalled");
  },
);

test(
  "the stage binding does not let a cell on a master Home be killed",
  { timeout: 15_000 },
  async (context) => {
    // The cell's own runtime decides, and it starts with the Worker's bindings, this one included.
    const { f, cell, command } = await ready(context, () => Response.json(documentedTopology), {
      POOL_ALLOW_MASTER_CRASH: "true",
    });
    const reasons = refusals(context);
    assert.equal((await crash(f, command)).status, 409);
    assert.deepEqual(reasons(), ["master"]);
    assert.deepEqual(cell.calls.signals, []);
    assert.deepEqual(f.old.calls.signals, []);
  },
);
