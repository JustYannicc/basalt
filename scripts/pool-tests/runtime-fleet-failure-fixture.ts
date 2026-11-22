import { SlotMemory } from "./runtime-slot-storage.ts";
import { RuntimeFleet } from "../../src/pool/runtime-fleet/controller.ts";
import { RuntimeFleetState } from "../../src/pool/runtime-fleet/state.ts";
import type { SlotIdentity, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import type { NativeStreamLease } from "../../src/pool/native-streams.ts";
const responseModule = "../../src/pool/native-response.worker.ts";
const {
  nativeResponse,
}: { nativeResponse(response: Response, lease: NativeStreamLease): Response } = await import(
  responseModule
);

export async function failureFleetFixture(maximum = 2) {
  const memory = new SlotMemory(),
    state = new RuntimeFleetState(memory, maximum);
  const pending: Promise<unknown>[] = [],
    sends: string[] = [];
  let sequence = 0,
    legacyCalls = 0,
    stopped = false;
  const target = (): SlotIdentity => ({
    format: "pool-runtime-slot-v1",
    controllerId: "controller",
    slotId: `slot-${++sequence}`,
    instanceId: `instance-${sequence}`,
    applicationId: "blue",
    applicationVersion: "1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: sequence,
    bootId: `boot-${sequence}`,
  });
  const cells = new Map<string, ReturnType<typeof createCell>>();
  function createCell(value: SlotTarget) {
    const identity = { ...value, bootId: `boot-${value.homePeerOrdinal}` };
    return {
      start: async () => identity,
      observe: async () => identity,
      selected: async () => identity,
      forward: async (
        _request: Request,
        _port: 8317,
        _pool: string | undefined,
        before: () => void,
      ) => {
        before();
        sends.push(value.instanceId);
        return new Response("terminal");
      },
      install: async () => {},
      abortPool: () => {},
      drain: async () => ({ active: 0, known: true }),
      retire: async (_identity: SlotIdentity, begin: () => Promise<void>) => begin(),
      retired: async () => true,
      failed: async () => stopped,
    };
  }
  const cell = (value: SlotTarget) => {
    let existing = cells.get(value.slotId);
    if (!existing) {
      existing = createCell(value);
      cells.set(value.slotId, existing);
    }
    return existing;
  };
  const createFleet = () =>
    new RuntimeFleet({
      state,
      target: async () => target(),
      cell,
      legacyActive: async () => 0,
      currentRequests: () => 0,
      targetActive: 10,
      idleMilliseconds: 60_000,
      maximum,
      now: Date.now,
      wrap: nativeResponse,
      defer: (work) => {
        pending.push(work);
      },
    });
  const fleet = createFleet();
  const add = async () => {
    const identity = target();
    await state.reserve(identity);
    await state.dispatch(identity);
    await state.ready(identity);
    return identity;
  };
  const forward = (signal?: AbortSignal, selected = fleet) =>
    selected.forward(
      new Request("http://pool/v1/responses", { signal }),
      "pool",
      async () => {
        legacyCalls++;
        return new Response("legacy");
      },
      () => {},
    );
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    memory,
    state,
    cell,
    add,
    fleet,
    forward,
    createFleet,
    settle,
    sends,
    legacyCalls: () => legacyCalls,
    stop: () => {
      stopped = true;
    },
  };
}
