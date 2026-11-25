import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { ContainerEnded, type SlotIdentity, type SlotTarget } from "./runtime-slots/contract.ts";
import type { NativeStreamLease } from "./native-streams.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import { fleetRouting } from "./runtime-fleet/production.ts";
import { forwardRecoverably } from "./runtime-fleet/retry.ts";
import { rememberRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { RemoteRuntimeDefect } from "./runtime-slots/request-error.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { runtimePlacementHeader } from "./runtime-placement.worker.ts";

const workerModule = "./forward.worker.ts";
const { forwardPoolRequest } = (await import(workerModule)) as {
  forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
};
const responseModule = "./native-response.worker.ts";
const { nativeResponse } = (await import(responseModule)) as {
  nativeResponse(response: Response, lease: NativeStreamLease): Response;
};

const rootImage = "root-image-input";
const cellImage = "cell-image-input";
const rootBoot = "0a5b1c9e-1111-4111-8111-000000000001";

/** A fleet with production routing; `add` makes a cell ready on `cellImage`. */
function fleetOf(rootRestarting = false, cellFails?: "before-send" | "after-send") {
  const state = new RuntimeFleetState(new SlotMemory(), 4, () => 100);
  const pending: Promise<unknown>[] = [];
  const selected = new Map<string, SlotIdentity>();
  const cells = new Map<string, FleetCell>();
  let index = 0;
  const target = (): SlotTarget => ({
    format: "pool-runtime-slot-v1",
    controllerId: "controller",
    slotId: `slot-${++index}`,
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: `instance-${index}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: cellImage,
    homePeerOrdinal: index,
  });
  const cell = (value: SlotTarget): FleetCell => {
    const existing = cells.get(value.slotId);
    if (existing) return existing;
    const next: FleetCell = {
      start: async () => {
        const identity = {
          ...value,
          bootId: `0a5b1c9e-2222-4222-8222-00000000000${value.homePeerOrdinal}`,
        };
        selected.set(value.slotId, identity);
        return identity;
      },
      observe: async () => selected.get(value.slotId),
      selected: async () => selected.get(value.slotId),
      forward: async (_request, _port, _pool, beforeDispatch) => {
        if (cellFails === "before-send") throw new Error("the cell refused before its send");
        beforeDispatch();
        // The cell's runtime ended after it accepted the call: the fleet builds the refusal.
        if (cellFails === "after-send") {
          const ended = new ContainerEnded();
          rememberRuntimeFailure("endpoint_request", ended);
          throw ended;
        }
        return new Response("served by a cell");
      },
      install: async () => {},
      abortPool: () => {},
      drain: async () => ({ active: 0, known: true }),
      retire: async (_identity, begin) => {
        await begin();
        return true;
      },
      retired: async () => true,
      failed: async () => false,
    };
    cells.set(value.slotId, next);
    return next;
  };
  const fleet = new RuntimeFleet({
    state,
    target: async () => ({ ...target(), bootId: "0a5b1c9e-2222-4222-8222-000000000000" }),
    cell,
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 1,
    maximum: 4,
    idleMilliseconds: 50,
    defer: (work) => {
      pending.push(work);
    },
    wrap: nativeResponse,
    now: () => 200,
    demandAt: () => {},
    ...fleetRouting,
    primaryAvailable: () => !rootRestarting,
    primaryHoldMs: () => (rootRestarting ? 200_000 : 0),
  });
  const add = async () => {
    const value = target();
    const identity = {
      ...value,
      bootId: `0a5b1c9e-2222-4222-8222-00000000000${value.homePeerOrdinal}`,
    };
    await state.reserve(identity);
    await state.dispatch(identity);
    selected.set(value.slotId, identity);
    await state.ready(identity);
    return identity;
  };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return { fleet, add, settle };
}

/**
 * The real forward path routed through the real fleet, as the pool object routes a model call:
 * the fleet decides between its cells and the object's own container (`legacy`).
 */
function harness(
  context: TestContext,
  options: {
    fetch?: (attempt: number) => Promise<Response>;
    rootRestarting?: boolean;
    cellFails?: "before-send" | "after-send";
    warm?: () => Promise<{ boot_id: string }>;
    /** Wraps the fleet's forward as production routing does, given the forward path's dispatch. */
    route?: (
      forward: (request: Request, dispatch: () => void) => Promise<Response>,
      request: Request,
      beforeDispatch: () => void,
    ) => Promise<Response>;
  } = {},
) {
  const events: Record<string, unknown>[] = [];
  context.mock.method(console, "info", (value: unknown) => {
    if (value && typeof value === "object" && "outcome" in value)
      events.push({ ...(value as Record<string, unknown>) });
  });
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const f = fleetOf(options.rootRestarting, options.cellFails);
  const background: Promise<unknown>[] = [];
  let attempts = 0;
  const forward = (request: Request) =>
    forwardPoolRequest(request, 8317, {
      env: { POOL_APP_SIGNING_KEY: "fixture", POOL_IMAGE_HASH: rootImage },
      appModel: { pool: "pool", person: "person", keyId: 1 },
      memberships: { configured: async () => false },
      streams: { active: 0 },
      protection: {},
      computers: { observeUsage: async () => {} },
      lifecycle: Promise.resolve({ warm: options.warm ?? (async () => ({ boot_id: rootBoot })) }),
      fetch: () =>
        options.fetch ? options.fetch(++attempts) : Promise.resolve(new Response("root")),
      route: (
        outbound: Request,
        _port: number,
        pool: string | undefined,
        legacy: (request: Request, beforeDispatch: () => void) => Promise<Response>,
        beforeDispatch: () => void,
      ) =>
        options.route
          ? options.route(
              (request, dispatch) => f.fleet.forward(request, pool, legacy, dispatch),
              outbound,
              beforeDispatch,
            )
          : f.fleet.forward(outbound, pool, legacy, beforeDispatch),
      defer: (work: Promise<unknown>) => {
        background.push(work);
      },
    });
  const drain = async () => {
    await f.settle();
    while (background.length) await background.shift();
  };
  return { events, forward, fleet: f, drain };
}

const call = () =>
  new Request("https://pool.invalid/v1/chat/completions", {
    method: "POST",
    body: '{"model":"m","messages":[]}',
  });
const runtimeOf = (event: Record<string, unknown> | undefined) => ({
  runtime: event?.runtime,
  slot: event?.slot,
  imageInput: event?.imageInput,
  boot: event?.boot,
  status: event?.status,
  outcome: event?.outcome,
});

test("a call the root serves names the root, its image and its boot", async (context) => {
  const h = harness(context);
  const response = await h.forward(call());
  assert.equal(await response.text(), "root");
  assert.equal(response.headers.has(runtimePlacementHeader), false);
  await h.drain();
  assert.deepEqual(runtimeOf(h.events[0]), {
    runtime: "root",
    slot: "legacy",
    imageInput: rootImage,
    boot: rootBoot,
    status: 200,
    outcome: "responded",
  });
});

test("a call a cell serves names that cell's slot, image and boot", async (context) => {
  const h = harness(context);
  const added = await h.fleet.add();
  const response = await h.forward(call());
  assert.equal(await response.text(), "served by a cell");
  assert.equal(response.headers.has(runtimePlacementHeader), false, "no caller sees the mark");
  await h.drain();
  assert.deepEqual(runtimeOf(h.events[0]), {
    runtime: "cell",
    slot: added.slotId,
    imageInput: cellImage,
    boot: added.bootId,
    status: 200,
    outcome: "responded",
  });
});

test("a call that moves from the root to a cell names the cell that answered it", async (context) => {
  let warms = 0;
  const h = harness(context, {
    rootRestarting: true,
    // The fleet reserves the first attempt for the root, which is restarting: it fails before it
    // is sent the call, a cell comes up meanwhile, and the next attempt is served there. Only a
    // call no runtime was sent moves; one the root was already sent stays the root's (below).
    warm: async () => {
      if (++warms > 1) return { boot_id: rootBoot };
      await h.fleet.add();
      const defect = new RemoteRuntimeDefect(crypto.randomUUID());
      rememberRuntimeFailure("endpoint_route", defect);
      throw defect;
    },
    route: (forward, request, beforeDispatch) =>
      forwardRecoverably(
        request,
        (current, dispatch) => forward(current, dispatch),
        beforeDispatch,
        async () => {},
        {
          timing: { now: () => 0, pause: async () => {} },
          rootHoldMs: () => h.fleet.fleet.primaryHoldMs(),
        },
      ),
  });
  const response = await h.forward(call());
  assert.equal(await response.text(), "served by a cell");
  await h.drain();
  // The event describes the answer the caller got, so it names the runtime that gave it.
  assert.deepEqual(runtimeOf(h.events[0]), {
    runtime: "cell",
    slot: "slot-1",
    imageInput: cellImage,
    boot: "0a5b1c9e-2222-4222-8222-000000000001",
    status: 200,
    outcome: "responded",
  });
});

test("a call refused before any runtime took it says unplaced in every runtime field", async (context) => {
  const h = harness(context, {
    warm: async () => {
      throw new PoolRuntimeUnhealthy();
    },
  });
  const response = await h.forward(call());
  assert.equal(response.status, 503);
  await response.text();
  await h.drain();
  assert.deepEqual(runtimeOf(h.events[0]), {
    runtime: "unplaced",
    slot: "unplaced",
    imageInput: "unplaced",
    boot: "unplaced",
    status: 503,
    outcome: "refused",
  });
});

test("a call the root had sent on and then lost stays the root's, with its unknown outcome", async (context) => {
  const h = harness(context, {
    fetch: async () => {
      throw new TypeError("connection lost");
    },
  });
  const response = await h.forward(call());
  await response.text();
  await h.drain();
  // Nothing moves a call its runtime may have run, so the root it was sent to is the one named.
  assert.deepEqual(runtimeOf(h.events[0]), {
    runtime: "root",
    slot: "legacy",
    imageInput: rootImage,
    boot: rootBoot,
    status: response.status,
    outcome: "outcome_unknown",
  });
});

/** The fleet's forward behind the real retry, as production wires it. */
const recovering = (
  forward: (request: Request, dispatch: () => void) => Promise<Response>,
  request: Request,
  beforeDispatch: () => void,
) =>
  forwardRecoverably(
    request,
    (current, dispatch) => forward(current, dispatch),
    beforeDispatch,
    async () => {},
    { timing: { now: () => 0, pause: async () => {} }, rootHoldMs: async () => 0 },
  );

test("a cell's failure after its send, and the refusal built from it, name that cell", async (context) => {
  const h = harness(context, { cellFails: "after-send", route: recovering });
  const added = await h.fleet.add();
  const response = await h.forward(call());
  await response.text();
  await h.drain();
  const event = runtimeOf(h.events[0]);
  assert.deepEqual(
    { runtime: event.runtime, slot: event.slot, imageInput: event.imageInput, boot: event.boot },
    { runtime: "cell", slot: added.slotId, imageInput: cellImage, boot: added.bootId },
  );
  assert.equal(event.status, response.status);
});

test("a cell that refuses before it is sent the call is no runtime that took it", async (context) => {
  const h = harness(context, { cellFails: "before-send" });
  await h.fleet.add();
  const response = await h.forward(call());
  await response.text();
  await h.drain();
  const event = runtimeOf(h.events[0]);
  assert.deepEqual(
    { runtime: event.runtime, slot: event.slot, imageInput: event.imageInput, boot: event.boot },
    { runtime: "unplaced", slot: "unplaced", imageInput: "unplaced", boot: "unplaced" },
  );
});

test("a mark the root's own container sends is dropped, and the root is named", async (context) => {
  const forged = `cell forged-slot forged-image ${rootBoot}`;
  const h = harness(context, {
    fetch: async () => new Response("root", { headers: { [runtimePlacementHeader]: forged } }),
  });
  const response = await h.forward(call());
  assert.equal(response.headers.has(runtimePlacementHeader), false);
  await response.text();
  await h.drain();
  assert.deepEqual(runtimeOf(h.events[0]), {
    runtime: "root",
    slot: "legacy",
    imageInput: rootImage,
    boot: rootBoot,
    status: 200,
    outcome: "responded",
  });
});
