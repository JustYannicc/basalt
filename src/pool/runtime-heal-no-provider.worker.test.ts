import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { forcedRestartBudgetMs, unservingBoundMs } from "./runtime-slots/forced-restart-timing.ts";

// A restart needs the provider observation for its admission and attestation; the forced stop does not.
// So a heal without a working token stops the stuck runtime and waits, and release checks prevent it.
type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Inspected {
  selection: { epoch: number; active: { identity: { bootId: string } } };
  recovery?: { restarts: number[]; needsPerson?: { reason: string } };
}

async function passes(f: Fixture, count: number) {
  for (let pass = 0; pass < count; pass++) {
    await f.upkeep();
    await f.settle();
  }
}

test(
  "the stuck record with the observation unavailable is stopped, reports needs-a-person, and heals when it returns",
  { timeout: 120_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    context.mock.method(console, "info", () => {});
    const errors = context.mock.method(console, "error", () => {});
    context.mock.method(console, "warn", () => {});
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    f.old.crash();
    await passes(f, 1);
    const previous = f.old.identity();
    const epoch = ((await f.send("inspect")) as Inspected).selection.epoch;
    const start = f.old.ctx.container.start.bind(f.old.ctx.container);
    f.old.crash();
    f.old.ctx.container.start = () => {
      f.old.revive();
      throw new Error("synthetic: the previous container is still running");
    };
    await passes(f, 1);
    f.old.ctx.container.start = start;
    await passes(f, 3);
    now += 3_600_000;
    await f.send("recovery-reset", { operationId: "incident-release" });
    // The heal ships while the provider observation token is unbound or empty.
    f.secretAvailable(false);
    for (
      let elapsed = 0;
      elapsed <= unservingBoundMs + forcedRestartBudgetMs + 30_000;
      elapsed += 2_000
    ) {
      await passes(f, 1);
      now += 2_000;
    }
    const during = (await f.send("inspect")) as Inspected;
    const pending = errors.mock.calls
      .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY_PENDING")
      .map((call) => String(call.arguments[1]));
    const observed = {
      stopped: f.old.calls.signals,
      running: f.old.ctx.container.running,
      epoch: during.selection.epoch - epoch,
      sameBoot: during.selection.active.identity.bootId === previous.bootId,
      needsPerson: during.recovery?.needsPerson?.reason,
      providerRefusals:
        pending.filter((line) => line.includes("ProviderObservationRefused")).length > 0,
    };
    // Once the token reads again, the same recovery restarts and commits.
    f.secretAvailable(true);
    await passes(f, 5);
    const after = (await f.send("inspect")) as Inspected;
    const health = await f.command("active-health");
    await health.body?.cancel();
    assert.deepEqual(
      {
        during: observed,
        after: {
          epoch: after.selection.epoch - epoch,
          newBoot: after.selection.active.identity.bootId !== previous.bootId,
          activeHealth: health.status,
        },
      },
      {
        during: {
          stopped: [15],
          running: false,
          epoch: 0,
          sameBoot: true,
          needsPerson: "restart_failed",
          providerRefusals: true,
        },
        after: { epoch: 1, newBoot: true, activeHealth: 200 },
      },
    );
  },
);
