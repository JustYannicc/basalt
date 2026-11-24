import assert from "node:assert/strict";
import { test } from "node:test";
import { runPoolFleet, type DispatchInput } from "./dispatch.ts";
import { controllerSettleMs } from "./operations.ts";
import { harness } from "./test/harness.ts";

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
