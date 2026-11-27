import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
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
const oldCode = () => runtimeErrorResponse(new SlotRefused("controller_code"), "handoff");
/** The same refusal from a controller on code from before its own reason, which said identity. */
const olderCode = () => runtimeErrorResponse(new SlotRefused("identity"), "handoff");
const cause = (result: Awaited<ReturnType<typeof runPoolFleet>>) =>
  String("cause" in result ? result.cause : "");
const reads = new Set(["inspect", "fleet-inspect", "fleet-retire-check"]);
const readOnly = [
  ["inspect", dispatch("inspect", { go: "" })],
  ["retire-check", dispatch("retire-check", { go: "", key: "0123abcd" })],
] as const;

/** A lane on the fake clock that keeps every line it logs; by default a deploy just finished. */
async function lane(options: (clock: { at: number; start: number }) => HarnessOptions) {
  const { clock, deps } = fakeClock();
  const fixture = await harness({ deployedAt: clock.start, ...options(clock) });
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
const deploymentReads = (fixture: { cloudflareReads: string[] }) =>
  fixture.cloudflareReads.filter((path) => path.endsWith(`/workers/scripts/${worker}/deployments`));

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
      "probe_wait window=330 seconds=40 reads=5 for=old_code,old_code,old_code,old_code",
    ]);
    assert.deepEqual(evidenceOf(result).probeWait, {
      window: 330,
      seconds: 40,
      reads: 5,
      for: ["old_code", "old_code", "old_code", "old_code"],
    });
    assert.ok(fixture.actions.every((action) => reads.has(action)));
  } finally {
    await fixture.close();
  }
});

test("a controller on code from before controller_code, which refuses the new signature as identity, is waited for as old code too", async () => {
  const { lines, fixture, run } = await lane((clock) => ({
    handoffFailure: () => (clock.at - clock.start < 20_000 ? olderCode() : undefined),
  }));
  try {
    const result = await run(dispatch("inspect", { go: "" }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(waitLines(lines), [
      "probe_wait window=330 seconds=20 reads=3 for=old_code,old_code",
    ]);
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
      "probe_wait window=330 seconds=40 reads=5 for=read_lost,read_lost,old_code,old_code",
    ]);
  } finally {
    await fixture.close();
  }
});

test("a read-only probe whose controller never takes the code fails at the bound with the refusal it gave before, saying it waited the bound, and sends nothing", async () => {
  for (const [mode, input] of readOnly)
    for (const [failure, refusal, waited] of [
      [
        oldCode,
        /^controller-code-mismatch: The controller refused reads signed for candidate c{40} for 330 s; /u,
        "old_code",
      ],
      [
        olderCode,
        /^controller-code-mismatch: The controller refused reads signed for candidate c{40} for 330 s; /u,
        "old_code",
      ],
      [
        () => new Error("bridge reset"),
        /^controller-not-ready: Error at step probe, still after 330 s; nothing was sent\./u,
        "read_lost",
      ],
      // A bridge 502 is lost on the way too, and the refusal keeps its status.
      [
        () => new Response(null, { status: 502 }),
        /^controller-not-ready: .*handoff\.response\.http=502.* at step probe, still after 330 s; /u,
        "read_lost",
      ],
    ] as const) {
      const { clock, lines, fixture, run } = await lane(() => ({ handoffFailure: failure }));
      try {
        const result = await run(input);
        assert.equal(result.ok, false, mode);
        assert.match(cause(result), refusal, mode);
        assert.equal(controllerSettleMs, 330_000);
        assert.ok(clock.at - clock.start >= controllerSettleMs);
        assert.equal(clock.sleeps.length, 33);
        assert.deepEqual(waitLines(lines), [
          `probe_wait window=330 seconds=330 reads=34 for=${Array(33).fill(waited).join(",")}`,
        ]);
        assert.deepEqual(evidenceOf(result).probeWait, {
          window: 330,
          seconds: 330,
          reads: 34,
          for: Array(33).fill(waited),
        });
        assert.ok(!("rollback" in result), "a read-only mode never had anything to roll back");
        assert.deepEqual([...new Set(fixture.actions)], ["inspect"]);
        assert.deepEqual(fixture.checks, []);
      } finally {
        await fixture.close();
      }
    }
});

test("each read taking time: no wait begins past the bound, so the wait ends a little after it, and the line counts the real seconds", async () => {
  // Each refused read costs 6 s, as the production probe's bridge setup does.
  const { clock, lines, fixture, run } = await lane((clock) => ({
    handoffFailure: (action) => {
      if (action !== "inspect") return undefined;
      clock.at += 6_000;
      return oldCode();
    },
  }));
  try {
    const result = await run(dispatch("inspect", { go: "" }));
    assert.equal(result.ok, false);
    assert.match(cause(result), /^controller-code-mismatch: .* for 330 s; /u);
    // Read n ends at 16n − 10 s: the 22nd, at 342 s, is the first past the bound.
    assert.equal(clock.at - clock.start, 342_000);
    assert.equal(clock.sleeps.length, 21);
    assert.deepEqual(waitLines(lines), [
      `probe_wait window=330 seconds=342 reads=22 for=${Array(21).fill("old_code").join(",")}`,
    ]);
    assert.deepEqual(evidenceOf(result).probeWait, {
      window: 330,
      seconds: 342,
      reads: 22,
      for: Array(21).fill("old_code"),
    });
  } finally {
    await fixture.close();
  }
});

test("a read-only probe long after the latest deployment reads once and refuses at once, as before, saying no window was left", async () => {
  for (const [mode, input] of readOnly) {
    const { clock, lines, fixture, run } = await lane((clock) => ({
      deployedAt: clock.start - 20 * 60_000,
      handoffFailure: () => oldCode(),
    }));
    try {
      const result = await run(input);
      assert.equal(result.ok, false, mode);
      assert.match(
        cause(result),
        /^controller-code-mismatch: The controller refused reads signed for candidate c{40}; /u,
        mode,
      );
      assert.deepEqual(clock.sleeps, [], mode);
      assert.deepEqual(waitLines(lines), ["probe_wait window=0 seconds=0 reads=1 for="]);
      assert.deepEqual(evidenceOf(result).probeWait, {
        window: 0,
        seconds: 0,
        reads: 1,
        for: [],
      });
      assert.deepEqual(fixture.actions, ["inspect"]);
      assert.equal(deploymentReads(fixture).length, 1);
    } finally {
      await fixture.close();
    }
  }
});

test("a read-only probe inside the window waits only for what is left of it, and its refusal says so", async () => {
  for (const [failure, refusal, waited] of [
    [
      oldCode,
      /^controller-code-mismatch: The controller refused reads signed for candidate c{40} for 130 s; /u,
      "old_code",
    ],
    [
      () => new Error("bridge reset"),
      /^controller-not-ready: Error at step probe, still after 130 s; nothing was sent\./u,
      "read_lost",
    ],
  ] as const) {
    // Deployed 200 s before the run: 130 s of the 330 s window are left.
    const { clock, lines, fixture, run } = await lane((clock) => ({
      deployedAt: clock.start - 200_000,
      handoffFailure: failure,
    }));
    try {
      const result = await run(dispatch("inspect", { go: "" }));
      assert.equal(result.ok, false);
      assert.match(cause(result), refusal);
      assert.equal(clock.at - clock.start, 130_000);
      assert.equal(clock.sleeps.length, 13);
      assert.deepEqual(waitLines(lines), [
        `probe_wait window=130 seconds=130 reads=14 for=${Array(13).fill(waited).join(",")}`,
      ]);
      assert.deepEqual([...new Set(fixture.actions)], ["inspect"]);
    } finally {
      await fixture.close();
    }
  }
});

test("an unreadable deployment time waits for nothing: the probe reads once and refuses as before, saying the window was unread", async () => {
  for (const deployedAt of ["unanswered", "none"] as const) {
    const { clock, lines, fixture, run } = await lane(() => ({
      deployedAt,
      handoffFailure: () => oldCode(),
    }));
    try {
      const result = await run(dispatch("inspect", { go: "" }));
      assert.equal(result.ok, false, deployedAt);
      assert.match(
        cause(result),
        /^controller-code-mismatch: The controller refused reads signed for candidate c{40}; /u,
      );
      assert.deepEqual(clock.sleeps, [], deployedAt);
      assert.deepEqual(waitLines(lines), ["probe_wait window=unread seconds=0 reads=1 for="]);
      assert.deepEqual(evidenceOf(result).probeWait, {
        window: "unread",
        seconds: 0,
        reads: 1,
        for: [],
      });
      assert.deepEqual(fixture.actions, ["inspect"]);
    } finally {
      await fixture.close();
    }
    // Unread never fails a run on its own: a current controller is inspected as ever.
    const current = await lane(() => ({ deployedAt }));
    try {
      const result = await current.run(dispatch("inspect", { go: "" }));
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(waitLines(current.lines), []);
    } finally {
      await current.fixture.close();
    }
  }
});

test("a probe that waited keeps what it waited for when a later read of the run fails", async () => {
  for (const [mode, input, later] of [
    [...readOnly[0], "fleet-inspect"],
    [...readOnly[1], "fleet-retire-check"],
  ] as const) {
    const { lines, fixture, run } = await lane((clock) => ({
      handoffFailure: (action) =>
        action === "inspect" && clock.at - clock.start < 20_000
          ? oldCode()
          : action === later
            ? new Error("bridge reset")
            : undefined,
    }));
    try {
      const result = await run(input);
      assert.equal(result.ok, false, mode);
      assert.equal(cause(result), "Error", mode);
      assert.deepEqual(waitLines(lines), [
        "probe_wait window=330 seconds=20 reads=3 for=old_code,old_code",
      ]);
      assert.deepEqual(evidenceOf(result).probeWait, {
        window: 330,
        seconds: 20,
        reads: 3,
        for: ["old_code", "old_code"],
      });
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
      "probe_wait window=330 seconds=30 reads=4 for=old_code,old_code,old_code",
    ]);
    assert.deepEqual(fixture.checks, ["0123abcd"]);
    assert.deepEqual(fixture.retires, []);
    assert.ok(fixture.actions.every((action) => reads.has(action)));
  } finally {
    await fixture.close();
  }
});

test("configure-and-accept waits out the handover as before, reads no deployment and still prints no wait line", async () => {
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
    assert.deepEqual(deploymentReads(fixture), []);
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
    assert.deepEqual(deploymentReads(fixture), []);
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

test("a clock that never moves still ends a shortened wait after the reads its bound allows", async () => {
  const fixture = await harness();
  try {
    let read = 0;
    const outcome = await Effect.runPromise(
      Effect.result(
        untilSettled<number, never>(
          { clock: { now: () => 0, sleep: async () => {} }, from: 0, boundMs: 30_000 },
          fixture.deps().controller(worker),
          Effect.sync(() => {
            read++;
            return { lagging: refuse("controller-bindings-differ", "lag.", "wait.") };
          }),
        ),
      ),
    );
    assert.ok(Result.isFailure(outcome));
    assert.equal(read, 4);
  } finally {
    await fixture.close();
  }
});
