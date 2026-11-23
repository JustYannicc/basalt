import assert from "node:assert/strict";
import { test } from "node:test";
import { ContainerEnds, classifyEnd } from "./runtime-slots/container-end.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";

/** One container process that several object instances can view, as after a reconstruction. */
function containerProcess() {
  let running = false;
  const waiters = new Map<object, Set<{ resolve(): void; reject(error: unknown): void }>>();
  return {
    view() {
      const view = {
        get running() {
          return running;
        },
        monitor: () =>
          running
            ? new Promise<void>((resolve, reject) => {
                const own = waiters.get(view) ?? new Set();
                own.add({ resolve, reject });
                waiters.set(view, own);
              })
            : Promise.resolve(),
      };
      return view;
    },
    start() {
      running = true;
    },
    /** The container ends: every instance still attached hears it. */
    end(how: { resolved: true } | { error: unknown }) {
      running = false;
      for (const own of waiters.values())
        for (const waiter of own) {
          if ("resolved" in how) waiter.resolve();
          else waiter.reject(how.error);
        }
      waiters.clear();
    },
    /** The instance that attached is gone; its monitor never settles. */
    forget(view: object) {
      waiters.delete(view);
    },
  };
}
const exit = (code: number) =>
  Object.assign(new Error(`Container exited with unexpected exit code: ${code}`), {
    exitCode: code,
  });
function memory() {
  const values = new Map<string, unknown>();
  return {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
  };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("each way a container ends is recorded as its own closed cause, never its message", () => {
  const cases: [Parameters<typeof classifyEnd>[0], string, number | null][] = [
    [{ resolved: true }, "exit", 0],
    [{ error: exit(1) }, "exit", 1],
    [{ error: exit(137) }, "exit", 137],
    [{ error: new Error("Runtime signalled the container to exit: 0") }, "signal", 0],
    [
      {
        error: new Error("Runtime signalled the container to exit due to a new version rollout: 0"),
      },
      "rollout",
      0,
    ],
    [
      {
        error: new Error(
          "There is no container instance that can be provided to this Durable Object, try again later",
        ),
      },
      "no_instance",
      null,
    ],
    [
      {
        error: new Error("Maximum number of running container instances exceeded. Try again later"),
      },
      "no_instance",
      null,
    ],
    [{ error: new Error("network connection lost") }, "unknown", null],
  ];
  for (const [outcome, cause, exitCode] of cases) {
    const end = classifyEnd(outcome, 5, false);
    assert.deepEqual(end, { at: 5, exitCode, cause, seen: "monitor" });
    assert.doesNotMatch(JSON.stringify(end), /exited with|signalled|try again|provided|lost/iu);
  }
});

test("a kill after the start is recorded with its exit code and no stop of ours", async () => {
  const process = containerProcess();
  const storage = memory();
  const ends = new ContainerEnds(storage, process.view(), () => 1_000);
  process.start();
  await ends.started();
  process.end({ error: exit(137) });
  await settled();
  const record = await ends.observe();
  assert.deepEqual(record?.current.end, {
    at: 1_000,
    exitCode: 137,
    cause: "exit",
    seen: "monitor",
  });
});

test("a stop we sent is never recorded as a crash, though the platform reads it as a kill", async () => {
  const process = containerProcess();
  const ends = new ContainerEnds(memory(), process.view(), () => 2_000);
  process.start();
  await ends.started();
  await ends.stopSent();
  // destroy() hands the monitor the same 137 a kill does.
  process.end({ error: exit(137) });
  await settled();
  assert.equal((await ends.observe())?.current.end?.stopSent, true);
});

test("an instance constructed while the container runs re-attaches, and hears the exit after a switch", async () => {
  const process = containerProcess();
  const storage = memory();
  const before = process.view();
  process.start();
  await new ContainerEnds(storage, before, () => 3_000).started();
  // A new code version: the old instance goes, its monitor with it; the container keeps running.
  process.forget(before);
  const after = new ContainerEnds(storage, process.view(), () => 4_000);
  await after.constructed();
  process.end({ error: exit(137) });
  await settled();
  const record = await after.observe();
  assert.equal(record?.current.startedAt, 3_000, "the boot started before the switch");
  assert.deepEqual(record?.current.end, {
    at: 4_000,
    exitCode: 137,
    cause: "exit",
    seen: "monitor",
  });
});

test("a container gone with no monitor outcome reads as found stopped, and the next start keeps it", async () => {
  const process = containerProcess();
  const storage = memory();
  const evicted = process.view();
  process.start();
  await new ContainerEnds(storage, evicted, () => 5_000).started();
  // Evicted while idle: the instance and its monitor are gone before the container ends.
  process.forget(evicted);
  process.end({ error: exit(137) });
  const woken = new ContainerEnds(storage, process.view(), () => 6_000);
  await woken.constructed();
  assert.deepEqual((await woken.observe())?.current.end, {
    at: 6_000,
    exitCode: null,
    cause: "unknown",
    seen: "found_stopped",
  });
  process.start();
  await woken.started();
  const record = await woken.observe();
  assert.equal(record?.previous?.seen, "found_stopped");
  assert.equal(record?.current.end, undefined);
});

test("a monitor that rejects while the container still runs records no end", async () => {
  const process = containerProcess();
  const view = process.view();
  const ends = new ContainerEnds(memory(), view, () => 7_000);
  process.start();
  await ends.started();
  // The transport to the monitor is lost; the container keeps running.
  const live = {
    ...view,
    running: true,
    monitor: () => Promise.reject(new Error("transport lost")),
  };
  const lost = new ContainerEnds(memory(), live, () => 7_000);
  await lost.constructed();
  await settled();
  assert.equal((await lost.observe())?.current.end, undefined);
});

test("the fleet keeps a retired cell's end on its tombstone and in the recent ends, newest first", async () => {
  const state = new RuntimeFleetState(new SlotMemory(), 4, () => 100);
  const end = (exitCode: number) => ({
    at: exitCode,
    exitCode,
    cause: "exit" as const,
    seen: "monitor" as const,
  });
  for (let index = 1; index <= 10; index++) {
    const target = {
      format: "pool-runtime-slot-v1" as const,
      controllerId: "controller",
      slotId: `slot-${index}`,
      applicationId: "blue",
      applicationVersion: "1",
      instanceId: `instance-${index}`,
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageInput: "image",
      homePeerOrdinal: 1,
    };
    const identity = { ...target, bootId: `boot-${index}` };
    await state.reserve(target);
    await state.dispatch(target);
    await state.ready(identity);
    await state.drain(identity);
    await state.beginRetirement(identity);
    await state.retired(identity, end(index));
  }
  const recent = await state.recentEnds();
  assert.deepEqual(
    recent.map(({ slotId, end }) => [slotId, end.exitCode]),
    [10, 9, 8, 7, 6, 5, 4, 3].map((index) => [`slot-${index}`, index]),
  );
});
