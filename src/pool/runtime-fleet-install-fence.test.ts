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
import { PoolDependencyFailure } from "./dependency-failure.ts";
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

/**
 * The answer production gave on 24 Nov: the endpoint's own connection to the cell's policy port
 * broke after 25 ms, which the route reports as a transport refusal of the membership dependency.
 */
function policyPortBroke() {
  const local = new PoolDependencyFailure("membership", new TypeError("Network connection lost."));
  rememberRuntimeFailure("endpoint_route", local);
  return retainRuntimeFailure(
    new Response(null, { status: 409, headers: runtimeFailureHeaders(local, "endpoint_route") }),
    new SlotRefused("uncertain"),
  );
}

/** The endpoint answered as another process than the one recorded. */
function anotherProcess() {
  const local = new SlotRefused("identity");
  rememberRuntimeFailure("endpoint_route", local);
  return retainRuntimeFailure(
    new Response(null, { status: 409, headers: runtimeFailureHeaders(local, "endpoint_route") }),
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
  // A call's answer the test holds open, to show what a fence does to calls already in flight.
  let answer: (() => Response) | undefined;
  const pending: Promise<unknown>[] = [];
  const create = () =>
    new RuntimeFleet({
      state: f.state,
      target: async () => {
        throw new Error("no new cell in this test");
      },
      cell: (target) => ({
        ...f.cell(target),
        ...(answer
          ? {
              forward: async (
                _request: Request,
                _port: 8317,
                _pool: string | undefined,
                before: () => void,
              ) => {
                before();
                return answer!();
              },
            }
          : {}),
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
    hold: (value: () => Response) => {
      answer = value;
    },
    row: async () => (await f.state.inspect()).find((value) => value.target.slotId === cell.slotId),
    /** The membership install at `at` ms, answered by `answer`. */
    install: async (
      at: number,
      answer: () => Promise<void>,
      which: Partial<NativeMembershipPolicy> = {},
    ) => {
      clock = at;
      install = answer;
      const result = await fleet.install({ ...policy, ...which }).then(
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

const broke = async () => {
  throw policyPortBroke();
};

test("an install whose connection to the cell's policy port broke fences the cell, owes the policy, and the next install lifts it", async (context) => {
  const s = await installFleet(context);
  assert.equal(await s.install(0, broke), "acknowledged");
  const row = await s.row();
  assert.equal(row?.phase, "ready", "one broken connection quarantined a serving cell");
  const suspect = readSuspect(row?.suspect);
  assert.deepEqual(suspect?.policyOwed, [policy.pool]);
  assert.equal(suspect?.reads[0]?.step, "endpoint_route");
  assert.equal(suspect?.reads[0]?.cause, "transport");
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  // The next renewal, 5 s on, lands; the following pass lifts the fence.
  await s.install(5_000, lands);
  await s.pass(6_000);
  assert.equal((await s.row())?.suspect, undefined);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "terminal");
});

test("two broken installs 6 s apart quarantine the cell on the install path, with both reads", async (context) => {
  const s = await installFleet(context);
  await s.install(0, broke);
  await s.install(6_000, broke);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "runtime_failed");
  const failure = readFailure(row?.failure);
  assert.equal(failure?.path, "install");
  assert.equal(failure?.rule, "failed_twice");
  assert.equal(failure?.reads.length, 2);
});

test("a policy owed for 30 s after a broken install is quarantined as unproven", async (context) => {
  const s = await installFleet(context);
  await s.install(0, broke);
  for (let at = 2_000; at < 30_000; at += 2_000) await s.pass(at);
  assert.equal((await s.row())?.phase, "ready");
  await s.pass(30_000);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(readFailure(row?.failure)?.rule, "unproven");
});

test("an install answered by another process than the one recorded quarantines at once, with its read", async (context) => {
  const s = await installFleet(context);
  await s.install(0, async () => {
    throw anotherProcess();
  });
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  const failure = readFailure(row?.failure);
  assert.equal(failure?.path, "install");
  assert.equal(failure?.rule, "evidence");
  assert.equal(failure?.reads[0]?.cause, "slot_identity");
});

test("an install round that was aborted holds acknowledgement and fences nothing", async (context) => {
  const s = await installFleet(context);
  const result = await s.install(0, async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  assert.ok(result instanceof Error, "an aborted install was acknowledged");
  const row = await s.row();
  assert.equal(row?.phase, "ready");
  assert.equal(row?.suspect, undefined);
});

test("a local failure of the install fences the cell rather than ending it", async (context) => {
  const s = await installFleet(context);
  assert.equal(
    await s.install(0, async () => {
      throw new Error("install transport failed");
    }),
    "acknowledged",
  );
  const row = await s.row();
  assert.equal(row?.phase, "ready");
  assert.deepEqual(readSuspect(row?.suspect)?.policyOwed, [policy.pool]);
});

test("a call already streaming from a cell finishes when a broken install fences it", async (context) => {
  const s = await installFleet(context);
  let push: ((text: string) => void) | undefined;
  let end: (() => void) | undefined;
  s.hold(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
            end = () => controller.close();
          },
        }),
      ),
  );
  const streaming = await s.f.forward(undefined, s.fleet);
  push!("first ");
  await s.install(1_000, broke);
  assert.ok(readSuspect((await s.row())?.suspect), "the broken install did not fence the cell");
  push!("second");
  end!();
  assert.equal(await streaming.text(), "first second");
});

test("an older revision that lands late never settles a newer revision the cell owes", async (context) => {
  const s = await installFleet(context);
  await s.install(0, refuse, { revision: 8 });
  // Revision 7, sent before 8, lands after it: the cell still lacks revision 8.
  await s.install(1_000, lands, { revision: 7 });
  await s.pass(2_000);
  assert.deepEqual(readSuspect((await s.row())?.suspect)?.policyOwed, [policy.pool]);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  await s.install(3_000, lands, { revision: 8 });
  await s.pass(4_000);
  assert.equal((await s.row())?.suspect, undefined);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "terminal");
});

test("another pool's install landing never settles the pool the cell owes", async (context) => {
  const s = await installFleet(context);
  await s.install(0, refuse, { pool: "pool-a" });
  await s.install(1_000, lands, { pool: "pool-b" });
  await s.pass(2_000);
  assert.deepEqual(readSuspect((await s.row())?.suspect)?.policyOwed, ["pool-a"]);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
});
