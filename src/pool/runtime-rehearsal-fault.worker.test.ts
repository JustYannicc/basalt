import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { membershipRefreshMs, membershipTtlMs } from "./membership-contract.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Inspected {
  selection: {
    epoch: number;
    active: { fenced: boolean; identity: { bootId: string } };
  };
  policies: { pool: string; dirty: boolean; expiresAt: number }[];
}
interface Witnessed {
  witness?: { operationId: string; bootId?: string };
}
const action = "rehearsal-restart-over-running";

async function passes(f: Fixture, count: number) {
  for (let pass = 0; pass < count; pass++) {
    await f.upkeep();
    await f.settle();
  }
}

/** Production's precondition: recovery had restarted the root once already, on 18 Nov. */
async function restartedRoot(f: Fixture) {
  await f.bootstrap();
  f.old.crash();
  await passes(f, 1);
  assert.equal(f.old.calls.start, 1);
  return {
    previous: f.old.identity(),
    epoch: ((await f.send("inspect")) as Inspected).selection.epoch,
  };
}

async function assertStuck(f: Fixture, previous: { bootId: string }, epoch: number) {
  assert.equal(f.old.ctx.container.running, true);
  assert.equal(f.old.identity().bootId, previous.bootId, "the old container still runs");
  const refused = await f.command("active-health");
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /runtime_endpoint_identity_slot_identity/u);
  const { witness } = (await f.send("witness", { target: f.old.target })) as Witnessed;
  assert.match(witness?.operationId ?? "", /^restart-/u);
  assert.equal(witness?.bootId, undefined, "the admitted restart never recorded a boot");
  const { selection } = (await f.send("inspect")) as Inspected;
  assert.equal(selection.epoch, epoch);
  assert.equal(selection.active.fenced, false);
  assert.equal(selection.active.identity.bootId, previous.bootId);
  const model = await f.model();
  assert.equal(model.status, 503);
  // Since #1407 (b121) the route answers a refusing runtime with the native retry advice; production
  // (16 Nov release) answers the same state with pool_protection_unavailable. Both are this state.
  assert.ok(model.headers.get("retry-after"), "the retry advice carries Retry-After");
  assert.match(await model.text(), /The model runtime restarted\. Please retry this request\./u);
}

test(
  "the rehearsal fault leaves production's stuck restart over a running root",
  { timeout: 30_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "error", () => {});
    context.mock.method(console, "warn", () => {});
    f.advanceCurrentBindings({ POOL_REHEARSAL_STAGE: "test-rehearsal-1" });
    const { previous, epoch } = await restartedRoot(f);
    const faulted = (await f.send(action)) as { operationId: string; epoch: number };
    assert.match(faulted.operationId, /^restart-/u);
    assert.equal(faulted.epoch, epoch);
    assert.equal(f.old.calls.start, 1, "the fault never starts the container");
    assert.equal(f.old.calls.destroy, 0);
    assert.deepEqual(f.old.calls.signals, []);
    await assertStuck(f, previous, epoch);
    await passes(f, 3);
    await assertStuck(f, previous, epoch);
    assert.equal(f.old.calls.start, 1, "recovery joins the restart and never starts it");
    // Every Home call is refused, so after one last renewal nothing renews the clean policy and it
    // lapses (on today's code, 15 to 20 s after the fault; the stage waits it out).
    for (let step = 0; step * membershipRefreshMs <= 3 * membershipTtlMs; step++) {
      now += membershipRefreshMs;
      await passes(f, 1);
      const row = ((await f.send("inspect")) as Inspected).policies.find(
        (item) => item.pool === f.claims.pool,
      );
      if (row && row.expiresAt <= now) break;
    }
    const { policies } = (await f.send("inspect")) as Inspected;
    const policy = policies.find((row) => row.pool === f.claims.pool);
    assert.equal(policy?.dirty, false);
    assert.ok(policy.expiresAt <= now, "the clean policy expired");
    await assertStuck(f, previous, epoch);
  },
);

for (const stage of [undefined, "production", "test-pr-12", "test-rehearsal-0"])
  test(`the rehearsal fault refuses on stage ${stage ?? "(unbound)"}`, async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "error", () => {});
    context.mock.method(console, "warn", () => {});
    if (stage) f.advanceCurrentBindings({ POOL_REHEARSAL_STAGE: stage });
    const { previous, epoch } = await restartedRoot(f);
    const before = (await f.send("witness", { target: f.old.target })) as Witnessed;
    const refused = await f.command(action);
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /runtime_endpoint_route_slot_selection/u);
    assert.deepEqual(await f.send("witness", { target: f.old.target }), before);
    const { selection } = (await f.send("inspect")) as Inspected;
    assert.equal(selection.epoch, epoch);
    assert.equal(selection.active.identity.bootId, previous.bootId);
    const health = await f.command("active-health");
    assert.equal(health.status, 200, await health.clone().text());
    await health.body?.cancel();
  });
