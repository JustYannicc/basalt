import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetCellFixture as fixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

test("a fleet cell joins provider reads to the retained actual start witness before it can forward", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  assert.equal(selected.bootId, f.identity().bootId);
  assert.equal(f.calls.start, 1);
  let dispatched = 0;
  const response = await f.cell.forward(
    new Request("http://pool/v1/responses"),
    8317,
    undefined,
    () => {
      dispatched++;
    },
  );
  await response.text();
  assert.equal(dispatched, 1);
  assert.equal(f.calls.model, 1);
  assert.deepEqual(await f.cell.drain(selected), { active: 0, known: true });
  await f.cell.retire(selected, async () => {});
  assert.equal(await f.cell.retired(selected), true);
  assert.equal(f.calls.destroy, 1);
  assert.equal(f.transport.stubs, 1);
});

test("an unavailable provider read cannot launch compute", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.failApplication(true);
  await assert.rejects(f.cell.start(f.target), /provider observation refused/);
  assert.equal(f.calls.start, 0);
  assert.equal(await f.cell.selected(), undefined);
});

test("a lost provider join after startup is recovered through observation without another start", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.failRuntime(true);
  await assert.rejects(f.cell.start(f.target), /provider observation refused/);
  assert.equal(f.calls.start, 1);
  assert.equal(await f.cell.selected(), undefined);
  f.failRuntime(false);
  assert.equal((await f.cell.observe(f.target))?.bootId, f.identity().bootId);
  assert.equal(f.calls.start, 1);
});

test("two plain health failures refuse model dispatch, and the next call reconnects", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const f = await fixture();
  context.after(f.cleanup);
  await f.cell.start(f.target);
  const before = f.transport.calls;
  f.transport.fail = true;
  await assert.rejects(
    f.cell.forward(new Request("http://pool/v1/responses"), 8317, undefined, () => {}),
    /native transport failed/,
  );
  assert.equal(f.transport.calls, before + 2);
  assert.equal(f.transport.stubs, 2);
  assert.equal(f.calls.model, 0);
  const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
  assert.equal(fields.reconnectEligible, true);
  assert.equal(fields.reconnectRan, true);
  assert.equal(fields.reconnectOutcome, "error");
  assert.equal(fields.attempts.length, 2);
  assert.equal(fields.attempts[0].error.disconnected, null);
  assert.equal(fields.identityHeaderPresent, false);
  f.transport.fail = false;
  const response = await f.cell.forward(
    new Request("http://pool/v1/responses"),
    8317,
    undefined,
    () => {},
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(f.transport.stubs, 3);
  assert.deepEqual(f.transport.modelStubs, [3]);
  assert.equal(f.calls.model, 1);
});

test("a missing observation secret cannot launch and the same cell activates when it appears", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.secret(null);
  await assert.rejects(f.cell.start(f.target), /provider observation refused/);
  assert.equal(f.calls.start, 0);
  assert.equal(await f.cell.selected(), undefined);
  f.secret("synthetic-provider-token");
  assert.equal(await f.cell.observe(f.target), undefined);
  assert.equal(f.calls.start, 0);
  assert.equal((await f.cell.observe(f.target, true))?.bootId, f.identity().bootId);
  assert.equal(f.calls.start, 1);
});

test("an absent observation secret holds draining capacity without destruction and later enables retirement", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  const state = new RuntimeFleetState(f.storage, 4);
  await state.reserve(f.target);
  await state.dispatch(f.target);
  await state.ready(selected);
  await state.drain(selected);
  const fleet = new RuntimeFleet({
    state,
    target: async () => f.target,
    cell: () => f.cell,
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 1,
    idleMilliseconds: 1000,
    maximum: 4,
    defer: () => {},
    wrap: f.wrap,
    now: Date.now,
  });
  f.secret(null);
  await assert.rejects(fleet.upkeep(), /provider observation refused/);
  assert.equal(f.calls.destroy, 0);
  assert.equal((await state.inspect()).length, 1);
  assert.equal((await state.inspect())[0]?.phase, "draining");
  f.secret("synthetic-provider-token");
  await fleet.upkeep();
  assert.equal(f.calls.destroy, 1);
  assert.deepEqual(await state.inspect(), []);
  assert.equal(f.calls.start, 1);
});

for (const staleFailure of ["flagged", "plain"] as const)
  test(`a ${staleFailure} cached stub reconnects health before the first model send`, async (context) => {
    const log = context.mock.method(console, "error", () => {});
    const f = await fixture(staleFailure);
    context.after(f.cleanup);
    const selected = await f.cell.start(f.target);
    assert.equal(f.transport.stubs, 1);
    f.transport.generation++;
    const direct = await f.stub.fetch(
      new Request("http://runtime/observe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: f.target }),
      }),
    );
    assert.equal(direct.status, 200);
    const observed = await direct.json();
    assert.equal(observed.identity.bootId, selected.bootId);
    let dispatched = 0;
    const response = await f.cell.forward(
      new Request("http://pool/v1/responses"),
      8317,
      undefined,
      () => {
        dispatched++;
      },
    );
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(f.transport.disconnected, 1);
    const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
    assert.equal(fields.reconnectEligible, true);
    assert.equal(fields.reconnectOutcome, "response");
    assert.equal(fields.attempts[0].error.disconnected, staleFailure === "plain" ? null : true);
    assert.equal(fields.attempts[0].error.retryable, staleFailure === "plain" ? null : true);
    assert.equal(fields.attempts[1].status, 200);
    assert.equal(f.transport.stubs, 2);
    assert.deepEqual(f.transport.modelStubs, [2]);
    assert.deepEqual(await f.cell.drain(selected), { active: 0, known: true });
    assert.equal(f.transport.stubs, 2);
    assert.equal(f.calls.start, 1);
    assert.equal(f.calls.model, 1);
    assert.equal(dispatched, 1);
  });

test("a disconnected health probe reconnects at most once before refusing dispatch", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const f = await fixture();
  context.after(f.cleanup);
  await f.cell.start(f.target);
  f.transport.generation++;
  f.transport.failHealth = true;
  const before = f.transport.calls;
  let dispatched = 0;
  await assert.rejects(
    f.cell.forward(new Request("http://pool/v1/responses"), 8317, undefined, () => {
      dispatched++;
    }),
    /synthetic stale endpoint stub/,
  );
  assert.equal(f.transport.calls, before + 2);
  assert.equal(f.transport.stubs, 2);
  assert.equal(f.transport.disconnected, 2);
  const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
  assert.equal(fields.reconnectEligible, true);
  assert.equal(fields.reconnectRan, true);
  assert.equal(fields.reconnectAcquired, true);
  assert.equal(fields.reconnectOutcome, "error");
  assert.deepEqual([fields.attempts[0].stub, fields.attempts[1].stub], [1, 2]);
  assert.deepEqual(
    [fields.attempts[0].error.disconnected, fields.attempts[1].error.disconnected],
    [true, true],
  );
  assert.equal(log.mock.callCount(), 1);
  assert.equal(f.calls.model, 0);
  assert.equal(dispatched, 0);
});

for (const failure of ["flagged", "plain"] as const)
  test(`a ${failure} error after model dispatch never resends the model request`, async (context) => {
    const f = await fixture();
    context.after(f.cleanup);
    await f.cell.start(f.target);
    f.hooks.model = async () => {
      const error = new Error("synthetic failure after model dispatch");
      if (failure === "flagged") Object.assign(error, { disconnected: true, retryable: true });
      throw error;
    };
    let dispatched = 0;
    await assert.rejects(
      f.cell.forward(new Request("http://pool/v1/responses"), 8317, undefined, () => {
        dispatched++;
      }),
    );
    assert.equal(f.transport.stubs, 1);
    assert.equal(f.calls.model, 1);
    assert.equal(dispatched, 1);
  });

for (const failure of ["overloaded", "non-error", "http"] as const)
  test(`a ${failure} health failure never reconnects`, async (context) => {
    const log = context.mock.method(console, "error", () => {});
    const f = await fixture(failure);
    context.after(f.cleanup);
    await f.cell.start(f.target);
    f.transport.generation++;
    const before = f.transport.calls;
    let dispatched = 0;
    await assert.rejects(
      f.cell.forward(new Request("http://pool/v1/responses"), 8317, undefined, () => {
        dispatched++;
      }),
    );
    assert.equal(f.transport.calls, before + 1);
    assert.equal(f.transport.stubs, 1);
    assert.equal(f.calls.model, 0);
    assert.equal(dispatched, 0);
    const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
    assert.equal(fields.reconnectEligible, false);
    assert.equal(fields.reconnectRan, false);
    assert.equal(fields.reconnectOutcome, "not_run");
    assert.equal(fields.attempts.length, 1);
    if (failure === "http") assert.equal(fields.attempts[0].status, 409);
  });

test("a plain control mutation error is never resent", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const f = await fixture("plain");
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  f.transport.generation++;
  const before = f.transport.calls;
  await assert.rejects(f.cell.drain(selected), /synthetic stale endpoint stub/);
  assert.equal(f.transport.calls, before + 1);
  assert.equal(f.transport.stubs, 1);
  const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
  assert.equal(fields.path, "/drain");
  assert.equal(fields.reconnectEligible, false);
  assert.equal(fields.reconnectOutcome, "not_run");
});
