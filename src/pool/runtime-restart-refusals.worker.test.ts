import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
type Pending = Record<string, unknown>;

async function stoppedRoot(context: TestContext) {
  context.mock.method(console, "info", () => {});
  const errors = context.mock.method(console, "error", () => {});
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  const pending = () =>
    errors.mock.calls
      .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY_PENDING")
      .map((call) => JSON.parse(String(call.arguments[1])) as Pending);
  return { f, pending };
}
async function pass(f: Fixture) {
  await f.upkeep();
  await f.settle();
}
async function serves(f: Fixture) {
  const response = await f.model();
  const text = await response.text();
  assert.equal(response.status, 200, text);
}

/**
 * What a restart reads after its container stopped, in order (STOP-OPTIONS §7). Each refusal must
 * name itself on the pending line, and the pool must serve again once its cause clears.
 */
const refusals: {
  name: string;
  fault(f: Fixture): () => void;
  expected: Pending;
}[] = [
  {
    name: "the provider read is refused (step 2)",
    fault: (f) => {
      f.providerAvailable(false);
      return () => f.providerAvailable(true);
    },
    expected: { class: "ProviderObservationRefused" },
  },
  {
    name: "the observation token is missing (step 2)",
    fault: (f) => {
      f.secretAvailable(false);
      return () => f.secretAvailable(true);
    },
    expected: { class: "ProviderObservationRefused" },
  },
  {
    name: "the platform does not start the new container (step 6)",
    fault: (f) => {
      const start = f.old.ctx.container.start.bind(f.old.ctx.container);
      f.old.ctx.container.start = () => {
        throw new Error("synthetic: no capacity");
      };
      return () => {
        f.old.ctx.container.start = start;
      };
    },
    expected: { class: "RemoteRuntimeDefect", step: "endpoint_route" },
  },
  {
    name: "the new boot's readiness refuses (step 7)",
    fault: (f) => {
      const old = f.old.identity().bootId;
      let refusing = true;
      f.old.hooks.health = async () =>
        refusing && f.old.identity().bootId !== old
          ? new Response(null, { status: 503 })
          : undefined;
      return () => {
        refusing = false;
      };
    },
    expected: { class: "SlotRefused", reason: "unhealthy", step: "endpoint_health" },
  },
  {
    name: "a policy install on the new boot fails (step 8)",
    fault: (f) => {
      let failing = true;
      f.old.hooks.install = async () => {
        if (failing) throw new Error("synthetic install failure");
      };
      return () => {
        failing = false;
      };
    },
    expected: { class: "SlotRefused", step: "endpoint_route" },
  },
];

for (const refusal of refusals)
  test(`a restart whose ${refusal.name} logs it by name and heals once it clears`, async (context) => {
    const { f, pending } = await stoppedRoot(context);
    const clear = refusal.fault(f);
    f.old.crash();
    await pass(f);
    const named = pending().at(-1);
    assert.ok(named, "the failed pass logged a pending line");
    for (const [field, value] of Object.entries(refusal.expected))
      assert.equal(named[field], value, `${field} in ${JSON.stringify(named)}`);
    clear();
    for (let attempt = 0; attempt < 4 && !f.old.ctx.container.running; attempt++) await pass(f);
    await pass(f);
    await serves(f);
  });

test("a fenced selection is refused by name before recovery reads the witness (step 1)", async (context) => {
  const { f, pending } = await stoppedRoot(context);
  await f.send("fence", { identity: f.old.identity() });
  f.old.crash();
  await pass(f);
  assert.deepEqual(
    { reason: pending().at(-1)?.reason, class: pending().at(-1)?.class },
    { reason: "slot_selection", class: "SlotRefused" },
  );
  assert.equal(f.old.calls.start, 0, "a fenced selection is never restarted");
});
