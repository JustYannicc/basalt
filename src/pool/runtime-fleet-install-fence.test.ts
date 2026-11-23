import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { failureFleetFixture as fixture } from "../../scripts/pool-tests/runtime-fleet-failure-fixture.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import {
  rememberRuntimeFailure,
  retainRuntimeFailure,
  runtimeFailureHeaders,
} from "./runtime-route-diagnostic.ts";
import { ControlFailure } from "./json.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { readFailure, readSuspect } from "./runtime-fleet/failure-record.ts";
import type { NativeMembershipPolicy } from "./membership-contract.ts";

const policy: NativeMembershipPolicy = {
  pool: "pool-a",
  organization: "organization",
  revision: 7,
  expiresAt: 60_000,
  accounts: [],
  dirty: false,
};

/** The endpoint's readiness read refused under its install, as the transport carries it. */
function readinessRefusal() {
  const local = new SlotRefused("unhealthy");
  rememberRuntimeFailure("endpoint_identity", local);
  return retainRuntimeFailure(
    new Response(null, { status: 409, headers: runtimeFailureHeaders(local, "endpoint_identity") }),
    new SlotRefused("uncertain"),
  );
}

/** One ready cell whose installs and health reads the test answers, on a clock the test moves. */
async function installFleet(context: TestContext) {
  let clock = 0;
  context.mock.method(Date, "now", () => clock);
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  const f = await fixture(2),
    cell = await f.add();
  let install: () => Promise<void> = async () => {};
  const pending: Promise<unknown>[] = [];
  const create = () =>
    new RuntimeFleet({
      state: f.state,
      target: async () => {
        throw new Error("no new cell in this test");
      },
      cell: (target) => ({
        ...f.cell(target),
        healthy: async () => undefined,
        install: async () => {
          if (target.slotId === cell.slotId) await install();
        },
      }),
      legacyActive: async () => 0,
      currentRequests: () => 0,
      targetActive: 10,
      idleMilliseconds: 600_000,
      maximum: 2,
      now: Date.now,
      wrap: (response) => response,
      defer: (work) => {
        pending.push(work);
      },
    });
  const fleet = create();
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  return {
    f,
    cell,
    fleet,
    create,
    row: async () => (await f.state.inspect()).find((value) => value.target.slotId === cell.slotId),
    /** The membership install at `at` ms, answered by `answer`. */
    install: async (at: number, answer: () => Promise<void>) => {
      clock = at;
      install = answer;
      const result = await fleet.install(policy).then(
        () => "acknowledged",
        (error: Error) => error,
      );
      await settle();
      return result;
    },
    /** One upkeep pass at `at` ms; this fixture's health reads are good. */
    pass: async (at: number) => {
      clock = at;
      await fleet.upkeep();
      await settle();
    },
  };
}
const refuse = async () => {
  throw readinessRefusal();
};
const lands = async () => {};

test("an install the readiness refused fences the cell and owes the policy, without holding acknowledgement", async (context) => {
  const s = await installFleet(context);
  assert.equal(await s.install(0, refuse), "acknowledged");
  const row = await s.row();
  assert.equal(row?.phase, "ready", "one refused install quarantined the cell");
  assert.deepEqual(readSuspect(row?.suspect)?.policyOwed, [policy.pool]);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  assert.deepEqual(s.f.sends, []);
});

test("a good health read never lifts the fence while the policy is owed; the install that lands does", async (context) => {
  const s = await installFleet(context);
  await s.install(0, refuse);
  await s.pass(2_000);
  assert.ok(
    readSuspect((await s.row())?.suspect),
    "a good read lifted a fence the policy still holds",
  );
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  // Nor from a fresh controller: the owed policy is durable.
  const fresh = s.create();
  assert.equal(await (await s.f.forward(undefined, fresh)).text(), "legacy");
  assert.equal(await s.install(4_000, lands), "acknowledged");
  assert.equal(readSuspect((await s.row())?.suspect)?.policyOwed, undefined);
  await s.pass(6_000);
  assert.equal((await s.row())?.suspect, undefined);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "terminal");
  assert.deepEqual(s.f.sends, [s.cell.instanceId]);
});

test("a refusal by the cell's policy layer still holds acknowledgement and fences nothing", async (context) => {
  const s = await installFleet(context);
  const result = await s.install(0, async () => {
    throw new ControlFailure(409, "backend_unavailable", "older revision");
  });
  assert.ok(result instanceof Error, "a policy-layer refusal was acknowledged");
  const row = await s.row();
  assert.equal(row?.phase, "ready");
  assert.equal(row?.suspect, undefined);
});

test("two refused installs 6 s apart quarantine the cell on the install path", async (context) => {
  const s = await installFleet(context);
  await s.install(0, refuse);
  await s.install(2_000, refuse);
  assert.equal((await s.row())?.phase, "ready");
  await s.install(6_000, refuse);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(readFailure(row?.failure)?.path, "install");
  assert.equal(readFailure(row?.failure)?.rule, "failed_twice");
});

test("a policy owed for 30 s with good reads and no install that lands is quarantined as unproven", async (context) => {
  const s = await installFleet(context);
  await s.install(0, refuse);
  for (let at = 2_000; at < 30_000; at += 2_000) await s.pass(at);
  assert.equal((await s.row())?.phase, "ready");
  await s.pass(30_000);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(readFailure(row?.failure)?.path, "install");
  assert.equal(readFailure(row?.failure)?.rule, "unproven");
});

test("an install that fails for another reason still quarantines as policy_refused", async (context) => {
  const s = await installFleet(context);
  await s.install(0, async () => {
    throw new Error("install transport failed");
  });
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "policy_refused");
});
