import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { SlotRefused, type SlotIdentity, type SlotTarget } from "./runtime-slots/contract.ts";
import type { NativeStreamLease } from "./native-streams.ts";
import { ControlFailure } from "./json.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import type { PrimaryRoute } from "./runtime-fleet/state.ts";
import { fleetRouting } from "./runtime-fleet/production.ts";
import { decodeResumeTarget } from "./stream-resume.ts";
import {
  rememberRuntimeFailure,
  retainRuntimeFailure,
  runtimeFailureHeaders,
} from "./runtime-route-diagnostic.ts";
import { forwardRecoverably } from "./runtime-fleet/retry.ts";
import { rootFallbackBurst } from "./runtime-fleet/root-fallback.ts";

const responseModule = "./native-response.worker.ts";
const { nativeResponse } = (await import(responseModule)) as {
  nativeResponse(response: Response, lease: NativeStreamLease): Response;
};

function fixture(
  maximum = 4,
  targetActive = 1,
  primary: {
    primary?: PrimaryRoute;
    primaryAvailable?(): boolean;
    recoverPrimary?(): Promise<void>;
  } = {},
) {
  const state = new RuntimeFleetState(new SlotMemory(), maximum, () => 100);
  const pending: Promise<unknown>[] = [];
  const cells = new Map<string, FleetCell>();
  const selected = new Map<string, SlotIdentity>();
  const calls = { starts: 0, dispatches: 0, legacy: 0, installs: 0, retires: 0 };
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  let index = 0,
    pressure = 0,
    retirementLost = false,
    now = 200;
  const demandAlarms: number[] = [];
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
  const cell = (value: SlotTarget) => {
    const existing = cells.get(value.slotId);
    if (existing) return existing;
    let retired = false;
    const next: FleetCell = {
      start: async () => {
        calls.starts++;
        const identity = { ...value, bootId: `boot-${value.homePeerOrdinal}` };
        selected.set(value.slotId, identity);
        return identity;
      },
      observe: async () => selected.get(value.slotId),
      selected: async () => selected.get(value.slotId),
      forward: async (_request, _port, _pool, beforeDispatch) => {
        beforeDispatch();
        calls.dispatches++;
        return new Response(
          new ReadableStream({
            start(controller) {
              bodies.push(controller);
            },
          }),
        );
      },
      install: async () => {
        calls.installs++;
      },
      abortPool: () => {},
      drain: async () => ({ active: 0, known: true }),
      retire: async (_identity, begin) => {
        await begin();
        calls.retires++;
        retired = true;
        if (retirementLost) throw new Error("lost retirement acknowledgement");
        return true;
      },
      retired: async () => retired,
      failed: async () => false,
    };
    cells.set(value.slotId, next);
    return next;
  };
  const fleet = new RuntimeFleet({
    state,
    target: async () => target(),
    cell,
    legacyActive: async () => pressure,
    currentRequests: () => pressure,
    targetActive,
    maximum,
    idleMilliseconds: 50,
    defer: (work) => {
      pending.push(work);
    },
    wrap: nativeResponse,
    now: () => now,
    demandAt: (at) => {
      demandAlarms.push(at);
    },
    ...primary,
  });
  const add = async () => {
    const value = target();
    await state.reserve(value);
    await state.dispatch(value);
    selected.set(value.slotId, value);
    await state.ready(value);
    return value;
  };
  const legacy = async () => {
    calls.legacy++;
    return new Response("legacy");
  };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    state,
    fleet,
    target,
    cell,
    add,
    calls,
    selected,
    bodies,
    legacy,
    settle,
    demandAlarms,
    advance: (at: number) => {
      now = at;
    },
    pressure: (value: number) => {
      pressure = value;
    },
    loseRetirement: () => {
      retirementLost = true;
    },
  };
}
const request = () => new Request("https://synthetic.invalid/v1/responses", { method: "POST" });

test("a burst inside the growth throttle arms one demand deadline and expands without another request", async () => {
  const f = fixture(3, 2);
  await (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text();
  await f.settle();
  assert.equal(f.calls.starts, 0);
  f.pressure(6);
  await Promise.all(
    [1, 2, 3].map(async () =>
      (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text(),
    ),
  );
  await f.settle();
  assert.deepEqual(f.demandAlarms, [300]);
  assert.equal(f.calls.starts, 0);
  f.advance(300);
  await f.fleet.upkeep();
  await f.settle();
  assert.equal(f.calls.starts, 3);
});

test("demand starts several named runtimes while legacy keeps serving the triggering request", async () => {
  const f = fixture(3, 2);
  f.pressure(6);
  assert.equal(
    await (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text(),
    "legacy",
  );
  await f.settle();
  assert.equal(f.calls.starts, 3);
  assert.equal(f.calls.legacy, 1);
  const responses = await Promise.all(
    [1, 2, 3].map(() => f.fleet.forward(request(), "pool", f.legacy, () => {})),
  );
  assert.deepEqual(
    (await f.state.inspect()).map((row) => row.active),
    [1, 1, 1],
  );
  await Promise.all(responses.map((response) => response.body!.cancel()));
  await f.settle();
});

test("the growth target never rejects extra work at the approved resource ceiling", async () => {
  const f = fixture(1, 1);
  await f.add();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => f.fleet.forward(request(), "pool", f.legacy, () => {})),
  );
  assert.equal(f.calls.dispatches, 10);
  assert.equal((await f.state.inspect())[0]?.active, 10);
  await Promise.all(responses.map((response) => response.body!.cancel()));
  await f.settle();
  assert.equal((await f.state.inspect())[0]?.active, 0);
});

test("planned drain lets an accepted delayed response finish before a single retirement", async () => {
  const f = fixture();
  const identity = await f.add();
  const cell = f.cell(identity),
    header = deferred();
  const original = cell.forward;
  cell.forward = async (...args) => {
    args[3]();
    await header.promise;
    return original(args[0], args[1], args[2], () => {});
  };
  const response = f.fleet.forward(request(), "pool", f.legacy, () => {});
  // The durable reservation marks acceptance before delayed upstream headers.
  const held = deferred();
  cell.selected = async () => {
    held.resolve();
    return identity;
  };
  await held.promise;
  await f.state.drain(identity);
  await f.fleet.upkeep();
  assert.equal(f.calls.retires, 0);
  header.resolve();
  const delivered = await response;
  const terminal = delivered.text();
  f.bodies[0]!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
  f.bodies[0]!.close();
  assert.equal(await terminal, "data: [DONE]\n\n");
  await f.settle();
  await f.fleet.upkeep();
  assert.equal(f.calls.retires, 1);
  assert.equal((await f.state.inspect()).length, 0);
});

test("lost retirement acknowledgement is inspected without repeating destruction", async () => {
  const f = fixture();
  const identity = await f.add();
  await f.state.drain(identity);
  f.loseRetirement();
  // The lost acknowledgement settles for its row; the pass itself goes on.
  await f.fleet.upkeep();
  assert.equal((await f.state.inspect())[0]?.phase, "retiring");
  await f.fleet.upkeep();
  assert.equal(f.calls.retires, 1);
  assert.equal((await f.state.inspect()).length, 0);
});

test("a failure after upstream dispatch is never retried on legacy", async () => {
  const f = fixture();
  const identity = await f.add();
  f.cell(identity).forward = async (_request, _port, _pool, beforeDispatch) => {
    beforeDispatch();
    f.calls.dispatches++;
    throw new Error("lost upstream reply");
  };
  await assert.rejects(
    f.fleet.forward(request(), "pool", f.legacy, () => {}),
    /lost upstream reply/,
  );
  assert.equal(f.calls.dispatches, 1);
  assert.equal(f.calls.legacy, 0);
  assert.equal((await f.state.inspect())[0]?.active, 0);
});

test("membership fanout includes an activated cell whose ready acknowledgement is still pending", async () => {
  const f = fixture();
  const identity = f.target();
  await f.state.reserve(identity);
  await f.state.dispatch(identity);
  f.selected.set(identity.slotId, identity);
  await f.fleet.install({
    pool: "pool",
    organization: "org",
    revision: 2,
    dirty: true,
    accounts: [],
    expiresAt: 1000,
  });
  assert.equal(f.calls.installs, 1);
});

const membership = () => ({
  pool: "pool",
  organization: "org",
  revision: 3,
  dirty: false,
  accounts: [],
  expiresAt: 1000,
});
// The controller sees a cell's install refusal the way the slot transport hands it over: a 409
// carrying the endpoint's step, reason and cause headers.
const refusal = (error: Error, step: "endpoint_health" | "endpoint_route") =>
  retainRuntimeFailure(
    new Response(null, { status: 409, headers: runtimeFailureHeaders(error, step) }),
    new SlotRefused("uncertain"),
  );
// What production's retiring cell answered: its health pre-check found no live policy lease.
const unhealthy = () => refusal(new SlotRefused("unhealthy"), "endpoint_health");
// The plugin answered and refused the policy itself, as for an older revision racing a newer one.
const policyRefused = () =>
  refusal(new ControlFailure(503, "backend_unavailable", "refused"), "endpoint_route");
const refusing = (f: ReturnType<typeof fixture>, identity: SlotIdentity, error = unhealthy()) => {
  f.cell(identity).install = async () => {
    f.calls.installs++;
    throw error;
  };
  return error;
};
const startingRow = async (f: ReturnType<typeof fixture>) => {
  const identity = f.target();
  await f.state.reserve(identity);
  await f.state.dispatch(identity);
  f.selected.set(identity.slotId, identity);
  return identity;
};

test("a retiring row is never asked for a policy, so its refusal cannot hold the fan-out", async () => {
  const f = fixture();
  const identity = await f.add();
  await f.state.drain(identity);
  f.loseRetirement();
  // The lost acknowledgement settles for its row; the pass itself goes on.
  await f.fleet.upkeep();
  assert.equal((await f.state.inspect())[0]?.phase, "retiring");
  refusing(f, identity);
  await f.fleet.install(membership());
  assert.equal(f.calls.installs, 0);
});

test("a ready row whose runtime fails the install leaves the selection, and the fan-out still resolves", async () => {
  const f = fixture();
  const identity = await f.add();
  refusing(f, identity);
  let served = 0;
  f.cell(identity).forward = async () => {
    served++;
    return new Response("stale");
  };
  await f.fleet.install(membership());
  assert.equal(f.calls.installs, 1);
  assert.equal(
    (await f.state.inspect()).find((row) => row.identity?.slotId === identity.slotId)?.phase,
    "quarantined",
  );
  await (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text();
  assert.equal(served, 0);
});

test("a ready row whose policy layer refuses the policy holds the fan-out and stays in the selection", async () => {
  const f = fixture();
  const identity = await f.add();
  const error = refusing(f, identity, policyRefused());
  await assert.rejects(f.fleet.install(membership()), (thrown) => thrown === error);
  assert.equal((await f.state.inspect())[0]?.phase, "ready");
});

test("a redrawn draining row that fails the install is never restored to serve under the old policy", async () => {
  const redrawn = async (f: ReturnType<typeof fixture>) => {
    const identity = await startingRow(f);
    await f.state.redraw(identity, undefined);
    assert.equal((await f.state.inspect())[0]?.phase, "draining");
    return identity;
  };
  // Without a refusal, upkeep restores a redrawn row when nothing else serves.
  const control = fixture(4, 1, { primaryAvailable: () => false });
  await redrawn(control);
  await control.fleet.upkeep();
  assert.equal((await control.state.inspect())[0]?.phase, "ready");

  const f = fixture(4, 1, { primaryAvailable: () => false });
  const identity = await redrawn(f);
  refusing(f, identity);
  await f.fleet.install(membership());
  await f.fleet.upkeep();
  assert.equal(
    (await f.state.inspect()).find((row) => row.identity?.slotId === identity.slotId)?.phase,
    "quarantined",
  );
});

test("a draining row that isn't redrawn settles its refusal with no quarantine and no replacement", async () => {
  const f = fixture();
  const identity = await f.add();
  await f.state.drain(identity);
  refusing(f, identity);
  await f.fleet.install(membership());
  assert.equal(f.calls.installs, 1);
  const rows = await f.state.inspect();
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["draining"],
  );
});

test("a starting row that refuses the policy still holds the fan-out", async () => {
  const f = fixture();
  const identity = await startingRow(f);
  const error = refusing(f, identity);
  await assert.rejects(f.fleet.install(membership()), (thrown) => thrown === error);
});

test("a pre-dispatch selection failure releases its reservation and lets planned drain finish", async (context) => {
  const f = fixture();
  const identity = await f.add();
  const entered = deferred(),
    release = deferred(),
    fenced = deferred();
  f.cell(identity).selected = async () => {
    entered.resolve();
    await release.promise;
    throw new Error("selection unavailable");
  };
  const originalDrain = f.state.drain.bind(f.state);
  context.mock.method(f.state, "drain", async (value: SlotIdentity) => {
    const active = await originalDrain(value);
    fenced.resolve();
    return active;
  });
  const request = f.fleet.forward(
    new Request("http://pool/v1/responses"),
    undefined,
    f.legacy,
    () => {},
  );
  const rejected = assert.rejects(request, /selection unavailable/);
  await entered.promise;
  const draining = f.fleet.drain(identity);
  await fenced.promise;
  assert.equal((await f.state.inspect())[0]?.active, 1);
  release.resolve();
  await rejected;
  assert.deepEqual(await draining, { active: 0, known: true });
  assert.equal((await f.state.inspect())[0]?.active, 0);
  assert.equal(f.calls.dispatches, 0);
  assert.equal(f.calls.legacy, 0);
});

test("with no sibling, an unavailable primary still gets the request's own admission", async () => {
  const f = fixture(4, 1, { primary: "balanced", primaryAvailable: () => false });
  const response = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  assert.equal(await response.text(), "legacy");
  assert.equal(f.calls.legacy, 1);
  await f.settle();
});

test("with no sibling, a primary that just failed admission is asked again, not refused", async () => {
  const f = fixture(4, 1, { primary: "balanced", primaryAvailable: () => true });
  let lapsed = true;
  const primary = async () => {
    if (lapsed) throw new Error("readiness unhealthy");
    return f.legacy();
  };
  await assert.rejects(
    f.fleet.forward(request(), "pool", primary, () => {}),
    /readiness/,
  );
  lapsed = false;
  const response = await f.fleet.forward(request(), "pool", primary, () => {});
  assert.equal(await response.text(), "legacy");
  await f.settle();
});

const served = async (response: Response, body?: ReadableStreamDefaultController<Uint8Array>) => {
  const text = response.text();
  body?.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
  body?.close();
  return text;
};

test("with production routing, a ready cell takes the call and the root serves none", async () => {
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  await f.add();
  const response = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  assert.equal(await served(response, f.bodies[0]), "data: [DONE]\n\n");
  assert.equal(f.calls.dispatches, 1);
  assert.equal(f.calls.legacy, 0);
  assert.equal(await f.state.primaryActive(), 0);
  await f.settle();
});

test("with production routing and no ready cell, the root serves the call", async () => {
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  const response = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  // A counted reservation, so a restarted controller's growth still sees the root's demand.
  assert.equal(await f.state.primaryActive(), 1);
  assert.equal(await response.text(), "legacy");
  assert.equal(f.calls.legacy, 1);
  assert.equal(f.calls.dispatches, 0);
  await f.settle();
  assert.equal(await f.state.primaryActive(), 0);
});

test("with production routing, a fenced root never fails a call a ready cell can serve", async () => {
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  await f.add();
  let rootCalls = 0;
  // A Home cancelled the root's node: every call the root takes is refused.
  const fenced = async () => {
    rootCalls++;
    return Response.json({ type: "error", error: { type: "overloaded_error" } }, { status: 503 });
  };
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => f.fleet.forward(request(), "pool", fenced, () => {})),
  );
  assert.equal(rootCalls, 0);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200],
  );
  await Promise.all(responses.map((response, index) => served(response, f.bodies[index])));
  assert.equal(f.calls.dispatches, 3);
  await f.settle();
});

test("with production routing, a recovered root's calls are counted reservations again", async () => {
  let recovered = false;
  const f = fixture(4, 1, {
    ...fleetRouting,
    primaryAvailable: () => true,
    recoverPrimary: async () => {
      if (!recovered) throw new Error("synthetic failed recovery");
    },
  });
  // A failed root call marks the root failed, and a failed recovery leaves it so.
  await assert.rejects(
    f.fleet.forward(
      request(),
      "pool",
      async () => {
        throw new Error("synthetic root failure");
      },
      () => {},
    ),
  );
  await f.settle();
  const fallback = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  assert.equal(await f.state.primaryActive(), 0, "a failed root serves only through the fallback");
  await fallback.text();
  await f.settle();
  // A recovery that succeeds clears the failure: growth sees the root's calls again.
  recovered = true;
  await f.fleet.recoverPrimary();
  const counted = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  assert.equal(await f.state.primaryActive(), 1);
  await counted.text();
  await f.settle();
  assert.equal(await f.state.primaryActive(), 0);
});

test("an answer the runtime can resume names that runtime as its resume target, and nothing else does", async () => {
  const f = fixture(3, 1);
  const identity = await f.add();
  const cell = f.cell(identity);
  cell.forward = async (_request, _port, _pool, beforeDispatch) => {
    beforeDispatch();
    return new Response("runtime", { headers: { "X-Basalt-Resume": "v1" } });
  };
  const fromRuntime = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  assert.deepEqual(decodeResumeTarget(fromRuntime.headers.get("X-Basalt-Resume-Target")), {
    kind: "runtime",
    identity,
  });
  assert.equal(await fromRuntime.text(), "runtime");
  cell.forward = async (_request, _port, _pool, beforeDispatch) => {
    beforeDispatch();
    return new Response("plain");
  };
  const plain = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  assert.equal(plain.headers.get("X-Basalt-Resume-Target"), null);
  await plain.text();
  await f.settle();

  const alone = fixture();
  const fromPrimary = await alone.fleet.forward(
    request(),
    "pool",
    async () => new Response("legacy", { headers: { "X-Basalt-Resume": "v1" } }),
    () => {},
  );
  assert.equal(fromPrimary.headers.get("X-Basalt-Resume-Target"), "primary");
  await fromPrimary.text();
  await alone.settle();
});

test("a runtime whose front layer fails keeps serving: no quarantine and no recovery", async () => {
  const f = fixture(3, 1);
  const identity = await f.add();
  const lost = new Error("Network connection lost.");
  rememberRuntimeFailure("resume_layer", lost);
  f.cell(identity).forward = async (_request, _port, _pool, beforeDispatch) => {
    beforeDispatch();
    throw lost;
  };
  await assert.rejects(
    f.fleet.forward(request(), "pool", f.legacy, () => {}),
    lost,
  );
  await f.settle();
  assert.ok((await f.state.inspect()).every((row) => row.phase !== "quarantined"));

  let recoveries = 0;
  await assert.rejects(
    forwardRecoverably(
      request(),
      async () => {
        throw lost;
      },
      () => {},
      async () => {
        recoveries++;
      },
    ),
    lost,
  );
  assert.equal(recoveries, 0);
});

test("with production routing and no ready cell, the root's answers resume on the root and its front layer never fails it", async () => {
  let recoveries = 0;
  const f = fixture(4, 1, {
    ...fleetRouting,
    primaryAvailable: () => true,
    recoverPrimary: async () => {
      recoveries++;
    },
  });
  const resumable = await f.fleet.forward(
    request(),
    "pool",
    async () => new Response("legacy", { headers: { "X-Basalt-Resume": "v1" } }),
    () => {},
  );
  assert.equal(resumable.headers.get("X-Basalt-Resume-Target"), "primary");
  assert.equal(await resumable.text(), "legacy");
  await f.settle();
  // The root's front layer fails: the call fails, but the root is neither failed nor recovered.
  const lost = new Error("Network connection lost.");
  rememberRuntimeFailure("resume_layer", lost);
  await assert.rejects(
    f.fleet.forward(
      request(),
      "pool",
      async () => {
        throw lost;
      },
      () => {},
    ),
    lost,
  );
  await f.settle();
  assert.equal(recoveries, 0);
  const next = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  assert.equal(await f.state.primaryActive(), 1, "the root still takes counted calls");
  assert.equal(await next.text(), "legacy");
  await f.settle();
});

test("a marked answer cut mid-body never counts against its runtime, and logs one line", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const f = fixture(3, 1);
  const identity = await f.add();
  const cell = f.cell(identity);
  const forward = cell.forward;
  cell.forward = async (...args) => {
    const answer = await forward(...args);
    return new Response(answer.body, { headers: { "X-Basalt-Resume": "v1" } });
  };
  const marked = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  const cut = marked.text();
  f.bodies[0]!.error(new Error("Network connection lost."));
  await assert.rejects(cut);
  await f.settle();
  assert.ok((await f.state.inspect()).every((row) => row.phase !== "quarantined"));
  const lines = log.mock.calls.filter((call) => call.arguments[0] === "POOL_RESUMABLE_STREAM_CUT");
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(String(lines[0]!.arguments[1]))), [
    "slot",
    "instance",
    "kind",
  ]);

  // The same cut on an answer the layer did not mark is the runtime's failure, as today.
  cell.forward = forward;
  const plain = await f.fleet.forward(request(), "pool", f.legacy, () => {});
  const plainCut = plain.text();
  f.bodies[1]!.error(new Error("Network connection lost."));
  await assert.rejects(plainCut);
  await f.settle();
  assert.ok((await f.state.inspect()).some((row) => row.phase === "quarantined"));
});

const burst = async (f: ReturnType<typeof fixture>, size: number) =>
  Promise.all(
    Array.from({ length: size }, async () => {
      const response = await f.fleet.forward(request(), "pool", f.legacy, () => {});
      return {
        status: response.status,
        retryAfter: response.headers.get("Retry-After"),
        unsent: response.headers.get("X-Signalbox-Controller-Unsent"),
        body: await response.text(),
      };
    }),
  );

test("with no ready cell, a burst sends the root at most its fallback bucket; the rest are refused unsent", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  const answers = await burst(f, 25);
  assert.equal(f.calls.legacy, rootFallbackBurst, "the root takes only the bucket");
  const refused = answers.filter((answer) => answer.status === 503);
  assert.equal(refused.length, 25 - rootFallbackBurst);
  // The retryable answer clients already follow, marked unsent so the entry re-sends a held call.
  assert.ok(refused.every((answer) => answer.retryAfter === "1" && answer.unsent === "1"));
  assert.equal(f.calls.dispatches, 0);
  const lines = log.mock.calls.filter((call) => call.arguments[0] === "POOL_ROOT_FALLBACK_REFUSED");
  assert.equal(lines.length, 25 - rootFallbackBurst);
  await f.settle();
  assert.equal(await f.state.primaryActive(), 0, "a refused call holds no root reservation");
});

test("a model catalog read never takes a root fallback token", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  const reads = await Promise.all(
    Array.from({ length: rootFallbackBurst + 5 }, async () => {
      const response = await f.fleet.forward(
        new Request("https://synthetic.invalid/v1/models"),
        "pool",
        f.legacy,
        () => {},
      );
      await response.text();
      return response.status;
    }),
  );
  assert.ok(reads.every((status) => status === 200));
  assert.equal(f.calls.legacy, rootFallbackBurst + 5);
  await f.settle();
});

test("a call the fleet refuses for capacity takes a root fallback token too", async (context) => {
  context.mock.method(console, "error", () => {});
  // No primary route: with no cell, acquire refuses for capacity and the call goes to the root.
  const f = fixture(4, 1, { primaryAvailable: () => false });
  const answers = await burst(f, 15);
  assert.equal(f.calls.legacy, rootFallbackBurst);
  assert.equal(answers.filter((answer) => answer.status === 503).length, 15 - rootFallbackBurst);
  await f.settle();
});

test("the root fallback refills at its rate, and a ready cell ends its effect", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  await burst(f, rootFallbackBurst + 1);
  assert.equal(f.calls.legacy, rootFallbackBurst);
  // A second at 1.2 a second earns one call back, and only one.
  f.advance(200 + 1_000);
  const next = await burst(f, 2);
  assert.deepEqual(next.map((answer) => answer.status).sort(), [200, 503]);
  assert.equal(f.calls.legacy, rootFallbackBurst + 1);
  await f.settle();
  // With a ready cell the root is no longer the fallback: every call is served, none refused.
  await f.add();
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => f.fleet.forward(request(), "pool", f.legacy, () => {})),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200],
  );
  assert.equal(f.calls.dispatches, 3);
  await Promise.all(responses.map((response, index) => served(response, f.bodies[index])));
  await f.settle();
});

test("a refused call still asks the fleet to grow", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  await burst(f, rootFallbackBurst);
  await f.settle();
  assert.equal(f.calls.starts, 0, "no pressure yet, so no growth");
  // Past the growth throttle, with demand, the only call is one the root's bucket refuses.
  f.pressure(3);
  f.advance(500);
  const [refused] = await burst(f, 1);
  assert.equal(refused!.status, 503);
  await f.settle();
  assert.ok(f.calls.starts >= 1, "the refused call still started a cell");
});

test("a root call that fails before its send gives its fallback token back", async (context) => {
  context.mock.method(console, "error", () => {});
  for (const primary of [
    { ...fleetRouting, primaryAvailable: () => true },
    { primaryAvailable: () => false },
  ]) {
    const f = fixture(4, 1, primary);
    // The root is briefly unhealthy: each call fails before it reaches anything, as retries do.
    const unsent = async () => {
      throw new Error("synthetic root readiness refused");
    };
    for (let attempt = 0; attempt < rootFallbackBurst + 5; attempt++)
      await assert.rejects(f.fleet.forward(request(), "pool", unsent, () => {}));
    // None of them cost the root anything, so a fresh burst still gets the whole bucket.
    const answers = await burst(f, rootFallbackBurst);
    assert.ok(answers.every((answer) => answer.status === 200));
    await f.settle();
  }
});

test("a video status poll is a model call and takes a root fallback token", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  const polls = await Promise.all(
    Array.from({ length: rootFallbackBurst + 5 }, async () => {
      const response = await f.fleet.forward(
        new Request("https://synthetic.invalid/v1/videos/video_1"),
        "pool",
        f.legacy,
        () => {},
      );
      await response.text();
      return response.status;
    }),
  );
  assert.equal(f.calls.legacy, rootFallbackBurst);
  assert.equal(polls.filter((status) => status === 503).length, 5);
  await f.settle();
});

test("a clock that steps back never earns the same span twice", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  await burst(f, rootFallbackBurst);
  f.advance(200 + 834);
  assert.deepEqual(
    (await burst(f, 1)).map((answer) => answer.status),
    [200],
  );
  // The clock steps back, and a call at that moment must not rewind the bucket's own time.
  f.advance(200);
  assert.deepEqual(
    (await burst(f, 1)).map((answer) => answer.status),
    [503],
  );
  f.advance(200 + 834);
  assert.deepEqual(
    (await burst(f, 1)).map((answer) => answer.status),
    [503],
  );
  await f.settle();
});

test(
  "while the root starts, at most a burst of counted calls wait for it, so they never all send at once",
  { timeout: 5_000 },
  async (context) => {
    context.mock.method(console, "error", () => {});
    const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
    const started = deferred<void>();
    let entered = 0;
    // The root's warm-up: calls wait here before their send.
    const starting = async (_request: Request, beforeDispatch: () => void) => {
      entered++;
      await started.promise;
      beforeDispatch();
      return new Response("legacy");
    };
    const waiting = Array.from({ length: rootFallbackBurst }, () =>
      f.fleet.forward(request(), "pool", starting, () => {}),
    );
    while (entered < rootFallbackBurst) await new Promise((resolve) => setImmediate(resolve));
    // The bucket refills while they wait, yet no more calls may queue behind the warm-up.
    f.advance(200 + 20_000);
    const pending = Array.from({ length: 5 }, () =>
      f.fleet.forward(request(), "pool", starting, () => {}),
    );
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entered, rootFallbackBurst, "no call joined the queue behind the warm-up");
    const later = await Promise.all(pending);
    assert.ok(later.every((response) => response.status === 503));
    started.resolve();
    const served = await Promise.all(waiting);
    assert.ok(served.every((response) => response.status === 200));
    // The wait earned nothing for the moment it ends: the root never sees more than a burst at once.
    const after = await burst(f, 5);
    assert.ok(after.every((answer) => answer.status === 503));
    await Promise.all([...served, ...later].map((response) => response.text()));
    await f.settle();
  },
);

test("a root call that fails after its send keeps its token spent", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture(4, 1, { ...fleetRouting, primaryAvailable: () => true });
  const failsAfterSend = async (_request: Request, beforeDispatch: () => void) => {
    beforeDispatch();
    throw new Error("synthetic failure after the send");
  };
  for (let call = 0; call < rootFallbackBurst; call++)
    await assert.rejects(f.fleet.forward(request(), "pool", failsAfterSend, () => {}));
  // It may have run: no refund, so the next call finds the bucket empty.
  assert.deepEqual(
    (await burst(f, 1)).map((answer) => answer.status),
    [503],
  );
  await f.settle();
});

test("growth logs its refusal once per change of reason, and again after a launch", async (context) => {
  const f = fixture(3, 1);
  const log = context.mock.method(console, "warn", () => {});
  // Each growth reserves once and stops at the first refusal; "ok" lets one launch through.
  const script: (SlotRefused["reason"] | "ok")[] = [
    "identity",
    "identity",
    "selection",
    "ok",
    "identity",
  ];
  const reserve = f.state.reserve.bind(f.state);
  context.mock.method(f.state, "reserve", async (...args: Parameters<typeof f.state.reserve>) => {
    const next = script.shift();
    if (next && next !== "ok") throw new SlotRefused(next);
    return reserve(...args);
  });
  const pass = async (at: number, pressure: number) => {
    f.pressure(pressure);
    f.advance(at);
    await (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text();
    await f.settle();
  };
  for (const at of [300, 500, 700, 900]) await pass(at, 3);
  // A pass that ends with nothing to do clears the refusal too, so the same reason logs again.
  await pass(1100, 0);
  script.push("identity");
  await pass(1300, 3);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [
      ["POOL_FLEET_GROWTH_REFUSED", { reason: "identity" }],
      ["POOL_FLEET_GROWTH_REFUSED", { reason: "selection" }],
      ["POOL_FLEET_GROWTH_REFUSED", { reason: "identity" }],
      ["POOL_FLEET_GROWTH_REFUSED", { reason: "identity" }],
    ],
  );
  assert.equal(f.calls.starts, 1);
});
