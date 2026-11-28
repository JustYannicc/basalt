import type { TestContext } from "node:test";
import { fleetCellFixture } from "./runtime-fleet-cell-fixture.ts";
import { runtimeFixtureCode } from "./runtime-handoff-proofs.ts";
import { RuntimeFleet, type FleetCell } from "../../src/pool/runtime-fleet/controller.ts";
import { RuntimeFleetState } from "../../src/pool/runtime-fleet/state.ts";
import { upkeepCadenceMs } from "../../src/pool/runtime-fleet/phase-bounds.ts";
import { forcedStopGraceMs } from "../../src/pool/runtime-slots/forced-restart-timing.ts";
import { RuntimeEndpoint } from "../../src/pool/runtime-slots/endpoint.ts";
import { RuntimeWitnessStore } from "../../src/pool/runtime-slots/witness-store.ts";
import { runtimeRequest } from "../../src/pool/runtime-slots/transport.ts";
import type { ControllerCode, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";

export const unready = () => new Response(null, { status: 503 });
export const gate = () => {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  return { open, opened, reached, arrived };
};

/**
 * A real fleet cell, its endpoint and its provider listing under one controller, on one clock the
 * test moves, as production reads `Date.now` for the ledger, the cell and the endpoint alike. The
 * stop's grace is spent on that clock, as for a Home that doesn't exit on SIGTERM. Growth draws the
 * fixture's slot first; later draws are stand-ins that never start.
 */
export async function stuckFleet(
  context: TestContext,
  options: { demand?: number; grace?: () => Promise<void>; abort?: false } = {},
) {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const warn = context.mock.method(console, "warn", () => {});
  const info = context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  const f = await fleetCellFixture("flagged", options.abort === false ? { abort: false } : {});
  context.after(f.cleanup);
  f.timing.stopGrace = options.grace ?? (async () => context.mock.timers.tick(forcedStopGraceMs));
  const state = new RuntimeFleetState(f.storage, 1, () => Date.now());
  const pending: Promise<unknown>[] = [];
  let drawn = 0;
  const standIn = {
    start: async () => {
      throw new Error("synthetic stand-in never starts");
    },
    observe: async () => undefined,
    selected: async () => undefined,
  } as unknown as FleetCell;
  const controller = (cell: FleetCell) =>
    new RuntimeFleet({
      state,
      target: async () =>
        drawn++ === 0
          ? f.target
          : {
              ...f.target,
              slotId: `slot-${drawn}`,
              instanceId: `instance-${drawn}`,
              homePeerOrdinal: 1 + drawn,
            },
      cell: (target: SlotTarget) => (target.slotId === f.target.slotId ? cell : standIn),
      legacyActive: async () => 0,
      currentRequests: () => options.demand ?? 0,
      targetActive: 1,
      idleMilliseconds: 60 * 60_000,
      maximum: 1,
      defer: (work) => {
        pending.push(work);
      },
      wrap: f.wrap,
      now: () => Date.now(),
    });
  let fleet = controller(f.cell);
  const store = new RuntimeWitnessStore(f.ctx.storage, f.env.POOL_DEPLOYMENT_KEY!);
  const row = async () =>
    (await state.inspect()).find((value) => value.target.slotId === f.target.slotId);
  let rootCalls = 0;
  return {
    f,
    state,
    row,
    /** One fleet alarm `milliseconds` later. Without `settle`, a stop under way keeps running. */
    async pass(milliseconds = upkeepCadenceMs, settle = true) {
      context.mock.timers.tick(milliseconds);
      await fleet.upkeep();
      while (pending.length) await Promise.allSettled(pending.splice(0));
      if (settle) await f.settle();
      return row();
    },
    /**
     * One fleet alarm that starts growth, which reserves the fixture's slot, starts it and admits
     * it. Later passes leave that growth running, so a test can hold its start across them.
     */
    async grow() {
      await fleet.upkeep();
      const growth = pending.splice(0);
      return () => Promise.allSettled(growth);
    },
    fenced: () => store.abandoned(f.target.slotId),
    /** Whether the endpoint holds an attestation for the fixture's slot. */
    attested: async () => (await store.retained(f.target.slotId))?.attestation !== undefined,
    /** The reason of each fleet upkeep line for a starting row that failed, in order. */
    upkeepRefusals: () =>
      info.mock.calls
        .map((call) => call.arguments[1] as { side?: string; phase?: string; outcome?: string })
        .filter(
          (line) =>
            line?.side === "fleet" &&
            line.outcome === "error" &&
            (line.phase === "warming" || line.phase === "uncertain"),
        )
        .map((line) => (line as { reason?: string }).reason),
    /** The fields of each line `name` warned, in order. */
    warned: (name: string) =>
      warn.mock.calls
        .filter((call) => call.arguments[0] === name)
        .map((call) => call.arguments[1] as Record<string, unknown>),
    /** Each code adoption line the endpoint logged, in order. */
    adoptions: () =>
      info.mock.calls
        .filter((call) => call.arguments[0] === "POOL_RUNTIME_CODE_ADOPTION")
        .map(
          (call) => call.arguments[1] as { outcome: string; held?: string; adoptingMs?: number },
        ),
    stops: () =>
      warn.mock.calls
        .filter((call) => call.arguments[0] === "POOL_RUNTIME_ABANDONED_STOP")
        .map((call) => (call.arguments[1] as { path: string }).path),
    /** One model call. The root answers 200 and counts it; a cell would answer it itself. */
    forward: async () => {
      const response = await fleet.forward(
        new Request("http://pool/v1/responses", { method: "POST" }),
        undefined,
        async (_request, beforeDispatch) => {
          beforeDispatch();
          rootCalls++;
          return new Response(null, { status: 200 });
        },
        () => {},
      );
      await response.text();
      return response.status;
    },
    rootCalls: () => rootCalls,
    /**
     * The controller's isolate replaced: a fresh fleet controller and cell over the same storage.
     * With `code`, the replacement runs that code, as after the controller's code handover; with
     * `changed`, under settings changed since the start.
     */
    replaceController(code?: ControllerCode, changed?: { POOL_DATABASE_URL?: string }) {
      fleet = controller(f.replacedCell(code, changed));
    },
    /** The cell's runtime object replaced: a fresh endpoint over the same storage and container. */
    replaceEndpoint() {
      const endpoint = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap, {
        ownStorage: f.ctx.storage,
      });
      f.stub.fetch = (request: Request) => runtimeRequest(request, endpoint);
    },
  };
}
export type Stuck = Awaited<ReturnType<typeof stuckFleet>>;
