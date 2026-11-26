import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { crashNonceKey } from "./runtime-crash-contract.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";
import { answerTopology, followerTopology } from "./test/home-topology.ts";
import { signEnvelope } from "./token.ts";

type Fleet = Awaited<ReturnType<typeof fleetWorkerFixture>>;

/**
 * One ready cell beside the primary, both on proven follower Homes, whose model calls stay open
 * until the test ends them. The fixture's calls all run in its one pool.
 */
async function ready(context: TestContext) {
  const f = await fleetWorkerFixture();
  const held: Response[] = [];
  // An open call keeps cleanup waiting, so a failed assertion ends every one first.
  context.after(async () => {
    for (const response of held) await response.body?.cancel().catch(() => {});
    await f.cleanup();
  });
  f.onRuntimeCreated(async (runtime) => {
    const container = runtime.ctx.container;
    const port = container.getTcpPort.bind(container);
    // A cell's Home listens on the peer port, which the shared fixture does not serve.
    container.getTcpPort = (number) =>
      number !== 8329 ? port(number) : { fetch: async () => Response.json(followerTopology()) };
  });
  answerTopology(f.old.home, () => Response.json(followerTopology()));
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "crash-pool-fleet",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const first = await f.model();
  assert.equal(first.status, 200);
  await first.body?.cancel();
  await f.settle();
  const [row] = await f.resourcesWhen((rows) => rows.some((value) => value.phase === "ready"));
  assert.ok(row?.identity);
  const cell = f.instances.get(row.target.instanceId)!.fixture;
  const served: string[] = [];
  f.onModel(async (instance) => {
    served.push(instance === cell ? "cell" : "primary");
    return new Response(new ReadableStream({}));
  });
  /** A model call of the fixture's pool, admitted and left in flight. */
  const hold = async () => {
    const response = await f.model();
    held.push(response);
    assert.equal(response.status, 200);
    assert.equal(served.at(-1), "cell", "the call runs on the cell");
    return response;
  };
  return { f, cell, identity: row.identity, hold, pool: f.claims.pool };
}

function packet(identity: SlotIdentity, fields: { kind?: "cell"; onlyPool?: string } = {}) {
  const at = Date.now();
  return {
    identity,
    nonce: crypto.randomUUID(),
    operator: "fixture-operator",
    at,
    expiresAt: at + 30_000,
    ...fields,
  };
}

async function crash(f: Fleet, command: ReturnType<typeof packet>) {
  const response = await f.worker.runtimeHandoff(
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
  const body = (await response.json()) as { reason?: string };
  return { status: response.status, reason: body.reason ?? "" };
}

/** The controller's own refusal lines, closed values only. */
function refusals(context: TestContext) {
  const warnings = context.mock.method(console, "warn", () => {});
  return () =>
    warnings.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.startsWith("POOL_CRASH_REFUSED "))
      .map((line) => JSON.parse(line.slice("POOL_CRASH_REFUSED ".length)) as object);
}

test("a cell holding only the test pool's calls is killed", async (context) => {
  const { f, cell, identity, hold, pool } = await ready(context);
  const held = [await hold(), await hold()];
  const command = packet(identity, { kind: "cell", onlyPool: pool });
  const response = await crash(f, command);
  assert.equal(response.status, 200, response.reason);
  assert.deepEqual(cell.calls.signals, [9]);
  assert.deepEqual(f.old.calls.signals, []);
  const submission = await f.old.storage.get<{ command: { onlyPool?: string }; status: string }>(
    crashNonceKey(command.nonce),
  );
  assert.equal(submission?.status, "returned");
  assert.equal(submission?.command.onlyPool, pool, "the submission records whose calls it may cut");
  for (const call of held) await call.body?.cancel();
});

test("one call from another pool in flight on the cell refuses the kill, until it ends", async (context) => {
  const { f, cell, identity, hold } = await ready(context);
  const reasons = refusals(context);
  const other = await hold();
  // The fixture's pool is the other pool here: the test's own has no call running.
  const command = packet(identity, { kind: "cell", onlyPool: "app_test-pool" });
  const refused = await crash(f, command);
  assert.equal(refused.status, 409);
  assert.match(refused.reason, /_other_pool_in_flight$/u);
  assert.deepEqual(reasons(), [
    { target: "cell", reason: "other_pool_in_flight", otherPools: 1, unnamed: 0, readable: true },
  ]);
  assert.deepEqual(cell.calls.signals, []);
  assert.equal(await f.old.storage.get(crashNonceKey(command.nonce)), undefined, "nonce unspent");
  await other.body?.cancel();
  await f.settle();
  const after = await crash(f, command);
  assert.equal(after.status, 200, after.reason);
  assert.deepEqual(cell.calls.signals, [9]);
});

test("a call on the cell whose pool the controller can't name refuses the kill", async (context) => {
  const { f, cell, identity, hold, pool } = await ready(context);
  const reasons = refusals(context);
  const own = await hold();
  // Counted against the cell with no call behind it here, as a lost release or a reservation not
  // yet forwarded is.
  const unnamed = await new RuntimeFleetState(f.old.storage, 4).acquire(Number.MAX_SAFE_INTEGER);
  assert.ok(unnamed.kind === "runtime" && unnamed.identity.bootId === identity.bootId);
  const command = packet(identity, { kind: "cell", onlyPool: pool });
  const refused = await crash(f, command);
  assert.equal(refused.status, 409);
  assert.match(refused.reason, /_other_pool_in_flight$/u);
  assert.deepEqual(reasons(), [
    { target: "cell", reason: "other_pool_in_flight", otherPools: 0, unnamed: 1, readable: true },
  ]);
  assert.deepEqual(cell.calls.signals, []);
  await unnamed.release();
  assert.equal((await crash(f, command)).status, 200);
  assert.deepEqual(cell.calls.signals, [9]);
  await own.body?.cancel();
});

test("a cell packet without its pool is refused before anything is read", async (context) => {
  const { f, cell, identity } = await ready(context);
  const command = packet(identity, { kind: "cell" });
  const refused = await crash(f, command);
  assert.equal(refused.status, 409);
  assert.match(refused.reason, /_slot_identity$/u);
  assert.deepEqual(cell.calls.signals, []);
  assert.equal(await f.old.storage.get(crashNonceKey(command.nonce)), undefined);
});

test("the primary path is unchanged: it names no pool, and other pools' calls on a cell don't stop it", async (context) => {
  const { f, cell, hold, pool } = await ready(context);
  const other = await hold();
  const named = await crash(f, packet(f.old.identity(), { onlyPool: pool }));
  assert.equal(named.status, 409, "a primary packet never carried a pool");
  assert.match(named.reason, /_slot_identity$/u);
  assert.deepEqual(f.old.calls.signals, []);
  const response = await crash(f, packet(f.old.identity()));
  assert.equal(response.status, 200, response.reason);
  assert.deepEqual(f.old.calls.signals, [9]);
  assert.deepEqual(cell.calls.signals, []);
  await other.body?.cancel();
});
