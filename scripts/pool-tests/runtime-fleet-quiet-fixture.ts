import { SlotMemory } from "./runtime-slot-storage.ts";
import type { SlotIdentity, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import type { NativeStreamLease } from "../../src/pool/native-streams.ts";
import { RuntimeFleetState, type PrimaryRoute } from "../../src/pool/runtime-fleet/state.ts";
import { RuntimeFleet, type FleetCell } from "../../src/pool/runtime-fleet/controller.ts";
import { FleetDemand } from "../../src/pool/runtime-fleet/demand.ts";

// The Worker gets its platform declarations in tsconfig.worker.json.
const responseModule = "../../src/pool/native-response.worker.ts";
const { nativeResponse } = (await import(responseModule)) as {
  nativeResponse(response: Response, lease: NativeStreamLease): Response;
};

/** A cell that runs nothing: its own count is zero and has not moved for as long as the test runs. */
const idleCount = { active: 0, known: true, stillMs: Number.MAX_SAFE_INTEGER };

/** What one cell does; each field replaces the healthy default for that call. */
export interface QuietCell {
  start?(target: SlotTarget): Promise<SlotIdentity>;
  observe?(target: SlotTarget): Promise<SlotIdentity | undefined>;
  drain?(): Promise<{ active: number; known: boolean; stillMs?: number }>;
  retired?(): Promise<boolean>;
  /** Whether the provider proves a start that never served gone; by default it does. */
  abandon?(): Promise<boolean>;
}

interface Options {
  maximum?: number;
  targetActive?: number;
  idleMilliseconds?: number;
  primary?: PrimaryRoute;
  primaryAvailable?(): boolean;
  legacy?(request: Request): Promise<Response>;
}

/**
 * One fleet controller over durable memory with a single clock shared by the ledger and the
 * controller, the way production reads `Date.now` for both. `pass` moves that clock and runs one
 * fleet upkeep the way the alarm does: a failed pass is logged and the next alarm runs again.
 */
export function quietFleet(options: Options = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const memory = new SlotMemory();
  const maximum = options.maximum ?? 4;
  const state = new RuntimeFleetState(memory, maximum, clock);
  const demand = new FleetDemand(memory);
  const pending: Promise<unknown>[] = [];
  const behaviour = new Map<string, QuietCell>();
  const selected = new Map<string, SlotIdentity>();
  const calls = { starts: 0, retires: 0, installs: 0, legacy: 0, failedPasses: 0 };
  let index = 0;
  const target = (): SlotIdentity => ({
    format: "pool-runtime-slot-v1",
    controllerId: "controller",
    slotId: `slot-${++index}`,
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: `instance-${index}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: index,
    bootId: `boot-${index}`,
  });
  const cell = (value: SlotTarget): FleetCell => {
    const own = () => behaviour.get(value.slotId) ?? {};
    let retired = false;
    return {
      start: async (requested) => {
        calls.starts++;
        const custom = own().start;
        const identity = custom
          ? await custom(requested)
          : { ...requested, bootId: `boot-${requested.homePeerOrdinal}` };
        selected.set(value.slotId, identity);
        return identity;
      },
      observe: async (requested) => {
        const custom = own().observe;
        return custom ? custom(requested) : selected.get(value.slotId);
      },
      selected: async () => selected.get(value.slotId),
      forward: async (_request, _port, _pool, beforeDispatch) => {
        beforeDispatch();
        return new Response(new ReadableStream({ start() {} }));
      },
      install: async () => {
        calls.installs++;
      },
      abortPool: () => {},
      drain: async () => (own().drain ? own().drain!() : { active: 0, known: true }),
      // The cell's own count, the same one its drain reports.
      activity: async () => (own().drain ? own().drain!() : idleCount),
      retire: async (_identity, begin) => {
        await begin();
        calls.retires++;
        retired = own().retired ? await own().retired!() : true;
        if (!retired) throw new Error("retirement not yet observed");
      },
      retired: async () => (own().retired ? own().retired!() : retired),
      failed: async () => false,
      abandon: async () => (own().abandon ? own().abandon!() : true),
    };
  };
  const controller = () =>
    new RuntimeFleet({
      state,
      target: async () => target(),
      cell,
      legacyActive: async () => 0,
      currentRequests: () => 0,
      targetActive: options.targetActive ?? 1,
      maximum,
      idleMilliseconds: options.idleMilliseconds ?? 60_000,
      defer: (work) => {
        pending.push(work);
      },
      wrap: nativeResponse,
      now: clock,
      recentDemandUntil: () => demand.until(),
      ...(options.primary ? { primary: options.primary } : {}),
      ...(options.primaryAvailable ? { primaryAvailable: options.primaryAvailable } : {}),
    });
  let fleet = controller();
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  const legacy = async (request: Request) => {
    calls.legacy++;
    return options.legacy ? options.legacy(request) : new Response("root");
  };
  return {
    state,
    calls,
    behaviour,
    get fleet() {
      return fleet;
    },
    now: () => now,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    /** A controller isolate replaced by the platform: memory and in-flight releases are gone. */
    restart() {
      pending.splice(0);
      fleet = controller();
    },
    /** A ready cell, admitted as growth admits one. */
    async add(behave: QuietCell = {}) {
      const value = target();
      behaviour.set(value.slotId, behave);
      await state.reserve(value);
      await state.dispatch(value);
      selected.set(value.slotId, value);
      await state.ready(value);
      return value;
    },
    /** A reserved cell the controller has not started yet. */
    async reserve(behave: QuietCell = {}) {
      const value = target();
      behaviour.set(value.slotId, behave);
      await state.reserve(value);
      return value;
    },
    /** One model call as PoolRuntimeFleet.forward makes it, recent demand included. */
    async call() {
      await demand.touch(now);
      return fleet.forward(
        new Request("https://synthetic.invalid/v1/responses", { method: "POST" }),
        "pool",
        (request, beforeDispatch) => {
          beforeDispatch();
          return legacy(request);
        },
        () => {},
      );
    },
    async pass(milliseconds = 2_000) {
      now += milliseconds;
      try {
        await fleet.upkeep();
      } catch {
        calls.failedPasses++;
      }
      await settle();
      return state.inspect();
    },
    /** Quiet passes at the production two-second cadence until `milliseconds` have gone by. */
    async quiet(milliseconds: number, step = 2_000) {
      for (let spent = 0; spent < milliseconds; spent += step) await this.pass(step);
      return state.inspect();
    },
    settle,
  };
}
