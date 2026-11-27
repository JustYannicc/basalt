import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { runPoolFleet, type DispatchInput } from "./dispatch.ts";
import { refuse } from "./errors.ts";
import { controllerSettleMs, untilSettled, type SettleWait } from "./operations.ts";
import { fakeClock } from "./test/fake-clock.ts";
import { harness, worker, type HarnessOptions } from "./test/harness.ts";
import { SlotRefused } from "../../src/pool/runtime-slots/contract.ts";
import { runtimeErrorResponse } from "../../src/pool/runtime-slots/request-error.ts";

const go = "coordinator-2026-11-27-inspect-settle";
const dispatch = (mode: string, extra: Partial<DispatchInput> = {}): DispatchInput => ({
  mode,
  go,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  ...extra,
});
/** The Worker's own 409 while the controller still runs the previous code: the new signature is refused. */
const oldCode = () => runtimeErrorResponse(new SlotRefused("identity"), "handoff");
const cause = (result: Awaited<ReturnType<typeof runPoolFleet>>) =>
  String("cause" in result ? result.cause : "");
const reads = new Set(["inspect", "fleet-inspect", "fleet-retire-check"]);

/** A lane on the fake clock that keeps every line it logs. */
async function lane(options: (clock: { at: number; start: number }) => HarnessOptions) {
  const { clock, deps } = fakeClock();
  const fixture = await harness(options(clock));
  const lines: string[] = [];
  return {
    clock,
    lines,
    fixture,
    run: (input: DispatchInput) =>
      runPoolFleet(input, { ...fixture.deps(), ...deps, log: (line) => lines.push(line) }),
  };
}
const waitLines = (lines: string[]) => lines.filter((line) => line.startsWith("probe_wait"));
const evidenceOf = (result: object) =>
  ("result" in result ? result.result : "evidence" in result ? result.evidence : {}) as {
    probeWait?: unknown;
  };

test("inspect waits while the controller still refuses the new code, then reads, and says how long it waited and for what", async () => {
  const { clock, lines, fixture, run } = await lane((clock) => ({
    handoffFailure: () => (clock.at - clock.start < 40_000 ? oldCode() : undefined),
  }));
  try {
    const result = await run(dispatch("inspect", { go: "" }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok("fleet" in evidenceOf(result), "the inspect itself ran once the code was taken");
    assert.deepEqual(clock.sleeps, [10_000, 10_000, 10_000, 10_000]);
    assert.deepEqual(waitLines(lines), [
      "probe_wait seconds=40 reads=5 for=old_code,old_code,old_code,old_code",
    ]);
    assert.deepEqual(evidenceOf(result).probeWait, {
      seconds: 40,
      reads: 5,
      for: ["old_code", "old_code", "old_code", "old_code"],
    });
    assert.ok(fixture.actions.every((action) => reads.has(action)));
  } finally {
    await fixture.close();
  }
});

test("a read lost on the way and old code are told apart, in the order they were waited for", async () => {
  const { lines, fixture, run } = await lane((clock) => ({
    handoffFailure: () =>
      clock.at - clock.start < 20_000
        ? new Error("bridge reset")
        : clock.at - clock.start < 40_000
          ? oldCode()
          : undefined,
  }));
  try {
    const result = await run(dispatch("inspect", { go: "" }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(waitLines(lines), [
      "probe_wait seconds=40 reads=5 for=read_lost,read_lost,old_code,old_code",
    ]);
  } finally {
    await fixture.close();
  }
});

test("inspect whose controller never takes the code fails at the bound with the refusal it gave before, saying it waited the bound, and sends nothing", async () => {
  for (const [failure, refusal] of [
    [
      oldCode,
      /^controller-code-mismatch: The controller refused reads signed for candidate c{40} for 330 s; /u,
    ],
    [
      () => new Error("bridge reset"),
      /^controller-not-ready: Error at step probe, still after 330 s; nothing was sent\./u,
    ],
  ] as const) {
    const { clock, lines, fixture, run } = await lane(() => ({ handoffFailure: failure }));
    try {
      const result = await run(dispatch("inspect", { go: "" }));
      assert.equal(result.ok, false);
      assert.match(cause(result), refusal);
      assert.equal(controllerSettleMs, 330_000);
      assert.ok(clock.at - clock.start >= controllerSettleMs);
      assert.equal(clock.sleeps.length, 33);
      const waited = failure === oldCode ? "old_code" : "read_lost";
      assert.deepEqual(waitLines(lines), [
        `probe_wait seconds=330 reads=34 for=${Array(33).fill(waited).join(",")}`,
      ]);
      assert.deepEqual(evidenceOf(result).probeWait, {
        seconds: 330,
        reads: 34,
        for: Array(33).fill(waited),
      });
      assert.ok(!("rollback" in result), "inspect never had anything to roll back");
      assert.deepEqual([...new Set(fixture.actions)], ["inspect"]);
    } finally {
      await fixture.close();
    }
  }
});

test("inspect against a controller that is already current waits for nothing and writes no wait line", async () => {
  const { clock, lines, fixture, run } = await lane(() => ({}));
  try {
    const result = await run(dispatch("inspect", { go: "" }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(clock.sleeps, []);
    assert.deepEqual(waitLines(lines), []);
    assert.ok(!("probeWait" in evidenceOf(result)));
  } finally {
    await fixture.close();
  }
});

test("retire-check sends nothing either, so its probe waits out the handover the same way", async () => {
  const { lines, fixture, run } = await lane((clock) => ({
    handoffFailure: () => (clock.at - clock.start < 30_000 ? oldCode() : undefined),
  }));
  try {
    const result = await run(dispatch("retire-check", { go: "", key: "0123abcd" }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(waitLines(lines), [
      "probe_wait seconds=30 reads=4 for=old_code,old_code,old_code",
    ]);
    assert.deepEqual(fixture.checks, ["0123abcd"]);
    assert.deepEqual(fixture.retires, []);
    assert.ok(fixture.actions.every((action) => reads.has(action)));
  } finally {
    await fixture.close();
  }
});

test("configure-and-accept waits out the handover as before and still prints no wait line", async () => {
  const { clock, lines, fixture, run } = await lane((clock) => ({
    handoffFailure: () => (clock.at - clock.start < 60_000 ? oldCode() : undefined),
  }));
  try {
    const result = await run(dispatch("configure-and-accept"));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(clock.at - clock.start >= 60_000);
    assert.ok(clock.sleeps.every((ms) => ms === 10_000));
    assert.deepEqual(
      fixture.actions.filter((action) => action === "fleet-configure"),
      ["fleet-configure"],
    );
    assert.deepEqual(waitLines(lines), []);
    assert.ok(!("probeWait" in evidenceOf(result)));
  } finally {
    await fixture.close();
  }
});

test("every mode that sends still probes once and refuses old code at once, without waiting", async () => {
  const { clock, lines, fixture, run } = await lane(() => ({ handoffFailure: () => oldCode() }));
  const sending = ["disable", "accept", "crash-cell", "bookmark", "retire-row"];
  try {
    for (const mode of sending) {
      const result = await run(dispatch(mode, { key: "0123abcd" }));
      assert.equal(result.ok, false, mode);
      assert.match(
        cause(result),
        /^controller-code-mismatch: The controller refused reads signed for candidate c{40}; /u,
        mode,
      );
    }
    assert.deepEqual(clock.sleeps, []);
    assert.deepEqual(waitLines(lines), []);
    assert.deepEqual(
      fixture.actions,
      sending.map(() => "inspect"),
    );
  } finally {
    await fixture.close();
  }
});

test("lagging bindings wait as their own closed value", async () => {
  const { deps } = fakeClock();
  const fixture = await harness();
  try {
    let read = 0;
    const waits: SettleWait[] = [];
    const value = await Effect.runPromise(
      untilSettled<number, never>(
        { clock: deps, from: deps.now() },
        fixture.deps().controller(worker),
        Effect.sync(() =>
          ++read < 3
            ? { lagging: refuse("controller-bindings-differ", "lag.", "wait.") }
            : { value: read },
        ),
        (wait) => waits.push(wait),
      ),
    );
    assert.equal(value, 3);
    assert.deepEqual(waits, ["bindings_lag", "bindings_lag"]);
  } finally {
    await fixture.close();
  }
});
