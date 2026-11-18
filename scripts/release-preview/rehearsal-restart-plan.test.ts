import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readySibling,
  RestartRefusal,
  runRestartCheck,
  type Observation,
  type Request,
  type SlotIdentity,
} from "./rehearsal-restart-plan.ts";

const old: SlotIdentity = { instanceId: "primary", bootId: "boot-1" };
const fresh: SlotIdentity = { instanceId: "primary", bootId: "boot-2" };
const sibling = { phase: "ready", identity: { instanceId: "cell", bootId: "cell-boot" }, active: 1 };
const fleet = (resources: NonNullable<NonNullable<Observation["fleet"]>["resources"]>) => ({
  permission: { enabled: true, configuration: { targetActive: 25 } },
  resources,
});
const observation = (identity: SlotIdentity, cells: boolean): Observation => ({
  selection: { active: { identity } },
  fleet: fleet(cells ? [sibling] : []),
  activeHealth: { identity, leaseMs: 900 },
});

/** A controller whose fleet grows a cell at `cellAt` workers and whose crash restarts after `restartMs`. */
function world(options: { cellAt?: number; restartMs?: number; served?: boolean }) {
  let clock = 0;
  let workers = 0;
  let crashedAt: number | undefined;
  const requests: Request[] = [];
  const events: string[] = [];
  return {
    events,
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        if (crashedAt !== undefined && options.served !== false)
          requests.push({ ok: true, startedAt: clock - ms + 1, endedAt: clock - 1 });
      },
      setConcurrency: (n: number) => void ((workers = n), events.push(`load:${n}`)),
      requests: () => requests,
      crash: async (identity: SlotIdentity) => {
        assert.deepEqual(identity, old);
        crashedAt = clock;
        events.push("crash");
      },
      observe: async () => {
        const cells = options.cellAt !== undefined && workers >= options.cellAt;
        const restarted = crashedAt !== undefined && clock - crashedAt >= (options.restartMs ?? 30_000);
        return observation(restarted ? fresh : old, cells);
      },
    },
  };
}

test("load rises until a cell is ready, then the crash recovers through the sibling", async () => {
  const { deps, events } = world({ cellAt: 4, restartMs: 30_000 });
  const result = await runRestartCheck(deps);
  assert.deepEqual(events, ["load:1", "load:2", "load:4", "crash"]);
  assert.equal(result.cellConcurrency, 4);
  assert.equal(result.siblingObserves, 3);
  assert.equal(result.signalToReadyMs, 30_000);
  assert.ok(result.servedWhileDown > 0);
});

test("without a sibling at the highest load it waits like the production proof, then refuses before any crash", async () => {
  const { deps, events } = world({});
  await assert.rejects(runRestartCheck(deps), (error: unknown) => error instanceof RestartRefusal && error.reason === "baseline-sibling-capacity");
  assert.ok(!events.includes("crash"));
  const late = world({ cellAt: 9 });
  await assert.rejects(runRestartCheck(late.deps), /baseline-sibling-capacity/);
});

test("a slow recovery or no service while the primary is down fails the check", async () => {
  await assert.rejects(runRestartCheck(world({ cellAt: 1, restartMs: 400_000 }).deps), /recovery-bound/);
  await assert.rejects(runRestartCheck(world({ cellAt: 1, served: false }).deps), /no-service-while-primary-down/);
});

test("the sibling test matches the controller's: ready, another instance, below target, fleet enabled", () => {
  assert.equal(readySibling(observation(old, true), old), true);
  assert.equal(readySibling({ ...observation(old, false), fleet: fleet([{ ...sibling, identity: old }]) }, old), false);
  assert.equal(readySibling({ ...observation(old, false), fleet: fleet([{ ...sibling, phase: "starting" }]) }, old), false);
  assert.equal(readySibling({ ...observation(old, false), fleet: fleet([{ ...sibling, active: 25 }]) }, old), false);
  assert.throws(() => readySibling({ ...observation(old, true), fleet: { ...fleet([sibling]), permission: { enabled: false } } }, old), /baseline-fleet-policy/);
});
