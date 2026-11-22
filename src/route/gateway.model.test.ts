import assert from "node:assert/strict";
import { test } from "node:test";
import { RouteGatewayCore } from "./gateway.ts";
import type { Reading, Selection } from "./reading.ts";
import { gatewayDependencies } from "./test/gateway.ts";

// Random event sequences against the state machine. Every container request is held until the
// scheduler answers or fails it, events arrive only when the object is idle (as workerd's input
// gate delivers them), and the invariants are checked after every step. A failure prints its seed;
// ROUTE_MODEL_SEED reruns one sequence and ROUTE_MODEL_SEQUENCES sets how many run.
const routeId = "rt_" + "a".repeat(26);
const owner = "org/org-1/user/person-1";
const caller = { routeId, owner };
const sequences = Number(process.env.ROUTE_MODEL_SEQUENCES ?? 2_000);
const only = process.env.ROUTE_MODEL_SEED;
const steps = 40;
/** ROUTE_MODEL_DEBUG=1 with a seed prints every step, request and start of that one sequence. */
const debug = process.env.ROUTE_MODEL_DEBUG
  ? (...line: unknown[]) => console.log(...line)
  : () => {};
const routed = new Set(["active", "direct_fallback"]);

function generator(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Lets everything that can run without a container reply run to its next wait. */
async function idle() {
  for (let round = 0; round < 25; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** How often the interesting paths ran, so a green run is known to have reached them. */
const reached = { connected: 0, selected: 0, refused: 0, tunnels: 0, disconnected: 0 };

async function sequence(seed: number, trace: string[]) {
  const random = generator(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const { deps, storage, container, advance } = gatewayDependencies();
  const gateway = new RouteGatewayCore(deps);
  await gateway.create({ routeId, owner, app: "tailscale" });
  // Most sequences begin signed in, with an exit on or off, so the walk spends its steps where
  // the races are rather than on reaching that state.
  const start = random();
  if (start < 0.8) {
    await gateway.login(caller);
    container.approve();
    await gateway.joinStatus(caller);
    if (start < 0.6) await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  }
  container.manual = true;

  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    const settled: Promise<unknown> = work.catch(() => {}).finally(() => pending.delete(settled));
    pending.add(settled);
    return settled;
  };
  // Every intent event invoked so far; a select that succeeds must have had none after it.
  let intents = 0;
  let signIns = 0;
  /** From a disconnect until the next sign-in: what started, and whether the disconnect is done. */
  let left: { nullStarts: number; identityStarts: number; done: boolean } | undefined;
  /** Since the last switch-off or disconnect, until an exit chosen after it is confirmed. */
  let quiet = false;
  const value = <T>(key: string) => storage.values.get(key) as T | undefined;

  container.onStart = (state) => {
    debug("  start", state === null ? "null" : "identity", left ? "after disconnect" : "");
    if (state === null) assert.ok(signIns > 0, "a node with no identity started outside a sign-in");
    if (left) {
      if (state === null) left.nullStarts += 1;
      else left.identityStarts += 1;
    }
  };

  const events: Record<string, () => void> = {
    signIn() {
      intents += 1;
      signIns += 1;
      left = undefined;
      track(gateway.login(caller).finally(() => (signIns -= 1)));
    },
    approve() {
      if (container.running && container.pendingLogin) {
        container.approve();
        // The person approved: the driver polls status next, as it does in the product.
        track(gateway.joinStatus(caller));
      }
    },
    status() {
      track(
        gateway.joinStatus(caller).then((joined) => {
          if (joined.state === "connected") reached.connected += 1;
        }),
      );
    },
    choose() {
      const selection: Selection = {
        exitId: pick(["n1", "n2"]),
        whenDown: pick(["stop", "direct"]),
      };
      const mine = (intents += 1);
      debug("  choose", JSON.stringify(selection));
      // A choice made after a switch-off may legitimately route; only an older one may not.
      quiet = false;
      track(
        gateway.select(caller, selection).then(
          () => {
            assert.equal(intents, mine, "a select succeeded after a later intent event");
            assert.deepEqual(
              value("route-v1:selection"),
              selection,
              "a confirmed select is not stored",
            );
            assert.ok(value("route-v1:state"), "an exit was chosen with no sealed identity");
            debug("  choice confirmed", JSON.stringify(selection));
            reached.selected += 1;
          },
          (error: unknown) => {
            debug("  choice refused", JSON.stringify(selection), (error as Error).message);
            reached.refused += 1;
            throw error;
          },
        ),
      );
    },
    switchOff() {
      intents += 1;
      let answered = false;
      track(
        gateway.select(caller, { exitId: null, whenDown: "stop" }).then(() => (answered = true)),
      );
      quiet = true;
      const busy = left !== undefined || signIns > 0;
      after.push(() => {
        assert.ok(answered, "switch-off did not answer without a container reply");
        assert.equal(value<Selection>("route-v1:selection")?.exitId ?? null, null);
        assert.equal(container.appliedExit, null, "switch-off left the gateway routing");
        // Only a disconnect's logout or a sign-in may own the container right after a switch-off.
        if (!busy && !left && signIns === 0)
          assert.equal(container.running, false, "switch-off left the gateway running");
      });
    },
    disconnect() {
      intents += 1;
      quiet = true;
      const window = { nullStarts: 0, identityStarts: 0, done: false };
      left = window;
      track(
        gateway.disconnect(caller).then(() => {
          window.done = true;
          reached.disconnected += 1;
        }),
      );
    },
    reading() {
      track(gateway.reading(caller));
    },
    alarm() {
      advance(30_000);
      track(gateway.alarm());
    },
    tunnel() {
      track(
        gateway.openTunnel({ owner }).then(async (socket) => {
          const reading = value<Reading>("route-v1:reading");
          assert.ok(reading && routed.has(reading.state), "a tunnel opened on a route not routed");
          assert.ok(value<Selection>("route-v1:selection")?.exitId, "a tunnel opened while off");
          reached.tunnels += 1;
          await socket.close();
        }),
      );
    },
    exits() {
      track(gateway.exits(caller));
    },
    crash() {
      container.crash();
    },
    exitDown() {
      container.exitOnline = !container.exitOnline;
    },
    /** Every held request is answered and nothing new arrives: the gateway must match storage. */
    async drain() {},
    answer() {
      const request = container.waiting.length ? pick(container.waiting) : undefined;
      if (!request) return;
      container.waiting.splice(container.waiting.indexOf(request), 1);
      const outcome = random() < 0.85 ? "ok" : "fail";
      debug("  answer", request.path, outcome, JSON.stringify(request.body ?? ""));
      request.release(outcome);
    },
  };
  const weights: Array<[string, number]> = [
    ["signIn", 1],
    ["approve", 3],
    ["status", 2],
    ["choose", 4],
    ["switchOff", 2],
    ["disconnect", 0.4],
    ["reading", 2],
    ["alarm", 2],
    ["tunnel", 5],
    ["exits", 1],
    ["crash", 0.6],
    ["exitDown", 2],
    ["drain", 1.5],
    ["answer", 20],
  ];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  const choose = () => {
    // A crash while a sign-in waits is where a dead link and an idle node come from.
    if (value("route-v1:login-until") !== undefined && random() < 0.15) return "crash";
    let at = random() * total;
    for (const [name, weight] of weights) if ((at -= weight) < 0) return name;
    return "answer";
  };
  let after: Array<() => void> = [];

  const check = () => {
    for (const assertion of after) assertion();
    after = [];
    if (left) {
      assert.equal(left.nullStarts, 0, "a node with no identity started after a disconnect");
      assert.ok(
        left.identityStarts <= 1,
        "more than the one logout node started after a disconnect",
      );
      assert.equal(value("route-v1:state"), undefined, "an identity came back after a disconnect");
      assert.equal(
        value("route-v1:login-until"),
        undefined,
        "a sign-in came back after a disconnect",
      );
      assert.equal(
        value<Selection>("route-v1:selection")?.exitId ?? null,
        null,
        "an exit came back after a disconnect",
      );
      if (left.done) assert.equal(container.running, false, "compute ran after a disconnect");
    }
    if (quiet) {
      const reading = value<Reading>("route-v1:reading");
      assert.ok(!reading || !routed.has(reading.state), "a stale reply turned a stopped route up");
    }
  };

  const drain = async () => {
    for (let round = 0; container.waiting.length > 0; round += 1) {
      assert.ok(round < 500, "held requests never drained");
      for (const request of container.waiting.splice(0)) {
        debug("  drain", request.path, JSON.stringify(request.body ?? ""));
        request.release("ok");
      }
      await idle();
    }
  };
  /** The gateway never routes an exit storage does not hold for a signed-in route. */
  const matched = () => {
    if (container.appliedExit === null) return;
    assert.ok(value("route-v1:state"), "the gateway routes with no sealed identity");
    assert.equal(
      container.appliedExit,
      value<Selection>("route-v1:selection")?.exitId ?? null,
      `the gateway routes ${container.appliedExit}, storage holds ${JSON.stringify(value("route-v1:selection"))}`,
    );
  };

  for (let step = 0; step < steps; step += 1) {
    const event = choose();
    trace.push(event);
    debug(step, event, "waiting:", container.waiting.map((request) => request.path).join(","));
    if (event === "drain") {
      await drain();
      check();
      if (pending.size === 0) matched();
      continue;
    }
    debug(step, event, "waiting:", container.waiting.map((request) => request.path).join(","));
    events[event]!();
    await idle();
    check();
  }
  // Every call must settle once the container answers; anything left is a deadlock.
  for (let round = 0; pending.size > 0 || container.waiting.length > 0; round += 1) {
    assert.ok(round < 2_000, `${pending.size} calls never settled`);
    for (const request of container.waiting.splice(0)) {
      debug("  settle", request.path, JSON.stringify(request.body ?? ""));
      request.release("ok");
    }
    await idle();
  }
  check();
  matched();
  // Once quiet, one more poll leaves the gateway running exactly what storage says.
  container.manual = false;
  container.exitOnline = true;
  advance(30_000);
  await gateway.alarm();
  const selection = value<Selection>("route-v1:selection");
  if (value("route-v1:state") && selection?.exitId)
    assert.equal(
      container.appliedExit,
      selection.exitId,
      "the gateway does not run the stored exit",
    );
  else assert.equal(container.appliedExit, null, "a gateway routes with no exit selected");
}

test(
  "random event sequences keep the route gateway's invariants",
  { timeout: Math.max(600_000, sequences * 100) },
  async (t) => {
    const seeds = only
      ? [Number(only)]
      : Array.from({ length: sequences }, (_, index) => index + 1);
    for (const seed of seeds) {
      const trace: string[] = [];
      try {
        await sequence(seed, trace);
      } catch (error) {
        assert.fail(
          `seed ${seed} (ROUTE_MODEL_SEED=${seed}): ${(error as Error).message}\nevents: ${trace.join(" ")}`,
        );
      }
    }
    t.diagnostic(`reached ${JSON.stringify(reached)}`);
    // A run that never signs in, confirms an exit or opens a tunnel proves nothing.
    if (!only)
      for (const [path, count] of Object.entries(reached))
        assert.ok(count > 0, `never reached: ${path}`);
  },
);
