import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallRecord } from "./load-call.ts";
import { phaseCounts, phaseLines, RuntimeOrdinals } from "./load-runtimes.ts";
import { parseLoadShape } from "./load-shape.ts";

const call = (startedAt: number, ...boots: (string | undefined)[]): CallRecord =>
  ({
    call: startedAt,
    worker: 0,
    kind: "chat-short",
    traceId: "0".repeat(32),
    startedAt,
    endedAt: startedAt + 1,
    attempts: boots.map((boot) => (boot === undefined ? {} : { boot })),
  }) as unknown as CallRecord;

test("each runtime is named by the order it first answered, and its boot id never leaves", () => {
  const ordinals = new RuntimeOrdinals();
  const written = [call(1, "boot-b"), call(2, "boot-a", "boot-b"), call(3, undefined)].map(
    (entry) => ordinals.record(entry),
  );
  assert.deepEqual(
    written.map((entry) => entry.attempts.map((attempt) => attempt.boot)),
    [["runtime-1"], ["runtime-2", "runtime-1"], [undefined]],
  );
  assert.doesNotMatch(JSON.stringify(written), /boot-a|boot-b/u);
});

test("a ramp's phases are its intervals while workers are added, then the hold", () => {
  const shape = parseLoadShape(
    JSON.stringify({
      concurrency: 25,
      durationMinutes: 10,
      ramp: { from: 5, step: 10, intervalSeconds: 60 },
      mix: [{ shape: "chat", weight: 1 }],
    }),
  );
  // From 5 by 10 to 25: two intervals of ramp, then held from 120 s on.
  const phases = phaseCounts(
    [
      call(1_000, "boot-a"),
      call(30_000, "boot-a"),
      call(61_000, "boot-a"),
      call(90_000, "boot-b"),
      call(121_000, "boot-b"),
      call(500_000, "boot-c", "boot-b"),
    ],
    shape,
    undefined,
  );
  assert.deepEqual(phases, [
    { phase: "ramp_1", calls: 2, runtimes: 1, answers: [2] },
    { phase: "ramp_2", calls: 2, runtimes: 2, answers: [1, 1] },
    { phase: "held", calls: 2, runtimes: 2, answers: [2, 1] },
  ]);
  assert.deepEqual(phaseLines(phases), [
    "load phase=ramp_1 calls=2 runtimes=1 answers=2",
    "load phase=ramp_2 calls=2 runtimes=2 answers=1,1",
    "load phase=held calls=2 runtimes=2 answers=2,1",
  ]);
});

test("a shape without a ramp is one steady phase, split at an armed kill", () => {
  const shape = parseLoadShape(
    JSON.stringify({ concurrency: 2, durationMinutes: 1, mix: [{ shape: "chat", weight: 1 }] }),
  );
  assert.deepEqual(phaseCounts([call(1, "boot-a"), call(2, undefined)], shape, undefined), [
    { phase: "steady", calls: 2, runtimes: 1, answers: [1] },
  ]);
  assert.deepEqual(phaseCounts([call(1, "boot-a"), call(5, "boot-b")], shape, 3), [
    { phase: "steady_before_kill", calls: 1, runtimes: 1, answers: [1] },
    { phase: "steady_after_kill", calls: 1, runtimes: 1, answers: [1] },
  ]);
  assert.deepEqual(phaseCounts([], shape, undefined), []);
});

test("a kill's resend is named by its runtime's ordinal like every other send", () => {
  const ordinals = new RuntimeOrdinals();
  const killed = {
    ...call(1, "boot-a"),
    inFlight: {
      ending: "cut",
      endedMsAfterKill: 5,
      retryable: true,
      bar: [],
      resend: { boot: "boot-b", passed: true },
    },
  };
  const written = ordinals.record(killed as never) as unknown as {
    inFlight: { resend: { boot: string } };
  };
  assert.equal(written.inFlight.resend.boot, "runtime-2");
  assert.doesNotMatch(JSON.stringify(written), /boot-a|boot-b/u);
});

test("a run of a million calls is counted without overflowing an argument list", () => {
  const shape = parseLoadShape(
    JSON.stringify({ concurrency: 2, durationMinutes: 1, mix: [{ shape: "chat", weight: 1 }] }),
  );
  const many = Array.from({ length: 200_000 }, (_, index) => call(index + 1, "boot-a"));
  assert.deepEqual(phaseCounts(many, shape, undefined), [
    { phase: "steady", calls: 200_000, runtimes: 1, answers: [200_000] },
  ]);
});
