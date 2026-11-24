import assert from "node:assert/strict";
import { test } from "node:test";
import { runPoolFleet, type DispatchInput } from "./dispatch.ts";
import { controllerSettleMs } from "./operations.ts";
import { harness } from "./test/harness.ts";
import { SlotRefused } from "../../src/pool/runtime-slots/contract.ts";
import { runtimeErrorResponse } from "../../src/pool/runtime-slots/request-error.ts";

const go = "coordinator-2026-11-24-fleet-settle";
const dispatch = (mode: string): DispatchInput => ({
  mode,
  go,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
});
/** A clock the lane's waits move, so a 300 s bound runs in no real time; signed commands stay fresh. */
const fakeClock = () => {
  const clock = { start: Date.now(), at: Date.now(), sleeps: [] as number[] };
  return {
    clock,
    deps: {
      now: () => clock.at,
      sleep: async (ms: number) => {
        clock.sleeps.push(ms);
        clock.at += ms;
      },
    },
  };
};
const cause = (result: Awaited<ReturnType<typeof runPoolFleet>>) =>
  String("cause" in result ? result.cause : "");

test("a controller read that keeps throwing waits out the handover, then refuses as controller-not-ready with its step, and sends nothing", async () => {
  const { clock, deps } = fakeClock();
  const lane = await harness({
    handoffFailure: (action) =>
      action === "fleet-inspect" ? new Error("bridge reset") : undefined,
  });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      ...deps,
    });
    assert.equal(result.ok, false);
    assert.match(
      cause(result),
      /^controller-not-ready: Error at step inspect, still after 300 s; nothing was sent\./u,
    );
    assert.ok(clock.at - clock.start >= controllerSettleMs);
    assert.ok(clock.sleeps.every((ms) => ms === 10_000));
    assert.ok(!lane.actions.includes("fleet-configure"));
  } finally {
    await lane.close();
  }
});

test("bindings that lag behind the settings for a while are waited for, and the configure then goes ahead", async () => {
  const { clock, deps } = fakeClock();
  const lane = await harness({ bindingsLag: () => clock.at - clock.start < 20_000 });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      ...deps,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(clock.sleeps.slice(0, 2), [10_000, 10_000]);
    assert.deepEqual(
      lane.actions.filter((action) => action === "fleet-configure"),
      ["fleet-configure"],
    );
    assert.equal((await lane.configuration.inspect())?.enabled, true);
  } finally {
    await lane.close();
  }
});

test("bindings that never match refuse at the bound as controller-bindings-differ, with nothing sent", async () => {
  const { clock, deps } = fakeClock();
  const lane = await harness({ bindingsLag: () => true });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      ...deps,
    });
    assert.equal(result.ok, false);
    assert.match(
      cause(result),
      /^controller-bindings-differ: fleet-inspect bindings still lack blue .* after 300 s/u,
    );
    assert.ok(clock.at - clock.start >= controllerSettleMs);
    assert.ok(!lane.actions.includes("fleet-configure"));
  } finally {
    await lane.close();
  }
});

test("a send the bridge answers without the Worker names the step and the answer's status", async () => {
  const lane = await harness({
    handoffFailure: (action) =>
      action === "fleet-configure" ? new Response(null, { status: 503 }) : undefined,
  });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), lane.deps());
    assert.equal(result.ok, false);
    assert.match(
      cause(result),
      /handoff\.command\.action=fleet-configure handoff\.response\.http=503 handoff\.response\.step=unclassified .*\) at step send$/u,
    );
  } finally {
    await lane.close();
  }
});

test("a refused inspect prints the answer's status, so a non-Worker answer shows as one", async () => {
  const lane = await harness({
    handoffFailure: (action) =>
      action === "inspect" ? new Response(null, { status: 502 }) : undefined,
  });
  try {
    const result = await runPoolFleet(dispatch("inspect"), lane.deps());
    assert.equal(result.ok, false);
    assert.match(cause(result), /handoff\.command\.action=inspect handoff\.response\.http=502/u);
  } finally {
    await lane.close();
  }
});

const oldCode = () => runtimeErrorResponse(new SlotRefused("identity"), "handoff");

test("the probe before configure waits too: a read lost on the way for a minute, then the configure goes ahead", async () => {
  const { clock, deps } = fakeClock();
  const lane = await harness({
    handoffFailure: (action) =>
      action === "inspect" && clock.at - clock.start < 60_000
        ? new Error("bridge reset")
        : undefined,
  });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      ...deps,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(clock.at - clock.start >= 60_000);
    assert.deepEqual(
      lane.actions.filter((action) => action === "fleet-configure"),
      ["fleet-configure"],
    );
  } finally {
    await lane.close();
  }
});

test("a controller still on its old code refuses the new signature until its handover ends, and the configure then goes ahead", async () => {
  const { clock, deps } = fakeClock();
  const lane = await harness({
    handoffFailure: () => (clock.at - clock.start < 60_000 ? oldCode() : undefined),
  });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      ...deps,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(clock.at - clock.start >= 60_000);
  } finally {
    await lane.close();
  }
});

test("old code past the handover refuses as controller-code-mismatch, sends nothing and disables nothing", async () => {
  const { clock, deps } = fakeClock();
  const lane = await harness({ handoffFailure: () => oldCode() });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      ...deps,
    });
    assert.equal(result.ok, false);
    assert.match(cause(result), /^controller-code-mismatch: /u);
    assert.ok(clock.at - clock.start >= controllerSettleMs);
    assert.deepEqual([...new Set(lane.actions)], ["inspect"]);
  } finally {
    await lane.close();
  }
});

test("any other Worker refusal stands at once, with its reason and step", async () => {
  const { clock, deps } = fakeClock();
  const lane = await harness({
    handoffFailure: (action) =>
      action === "fleet-inspect"
        ? runtimeErrorResponse(new SlotRefused("selection"), "handoff")
        : undefined,
  });
  try {
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      ...deps,
    });
    assert.equal(result.ok, false);
    assert.match(cause(result), /handoff\.response\.reason=slot_selection .*\) at step inspect$/u);
    assert.deepEqual(clock.sleeps, []);
  } finally {
    await lane.close();
  }
});

test("a clock that never moves still ends the wait, after one read per poll of the window", async () => {
  const sleeps: number[] = [];
  const lane = await harness({ bindingsLag: () => true });
  try {
    const now = Date.now();
    const result = await runPoolFleet(dispatch("configure-and-accept"), {
      ...lane.deps(),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result.ok, false);
    assert.match(cause(result), /^controller-bindings-differ: /u);
    assert.equal(sleeps.length, controllerSettleMs / 10_000);
  } finally {
    await lane.close();
  }
});

test("a refusal before any send leaves a fleet another GO enabled as it was", async () => {
  let lagging = false;
  const lane = await harness({ bindingsLag: () => lagging });
  try {
    assert.equal((await runPoolFleet(dispatch("configure-and-accept"), lane.deps())).ok, true);
    lagging = true;
    const { deps } = fakeClock();
    const result = await runPoolFleet(
      { ...dispatch("configure-and-accept"), go: "coordinator-2026-11-24-fleet-settle-2" },
      { ...lane.deps(), ...deps },
    );
    assert.equal(result.ok, false);
    assert.match(cause(result), /^controller-bindings-differ: /u);
    assert.deepEqual((result as { rollback: unknown }).rollback, { skipped: "nothing-sent" });
    assert.ok(!lane.actions.includes("fleet-disable"));
    assert.equal((await lane.configuration.inspect())?.enabled, true);
  } finally {
    await lane.close();
  }
});
