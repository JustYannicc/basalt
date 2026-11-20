import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { unfenceHandBackAfterMs } from "./runtime-slots/controller.ts";
import { unservingBoundMs } from "./runtime-slots/forced-restart-timing.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Slot {
  fenced: boolean;
  fencedAt?: number;
  unfenced?: { by: string; at: number; proven: boolean };
  identity?: { bootId: string };
}

async function root(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  return {
    f,
    identity: f.old.identity(),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
async function pass(f: Fixture) {
  await f.upkeep();
  await f.settle();
}
async function selection(f: Fixture) {
  return ((await f.send("inspect")) as { selection: { epoch: number; active: Slot } }).selection;
}
async function unfence(f: Fixture, identity: ReturnType<Fixture["old"]["identity"]>) {
  const response = await f.command("unfence", { identity });
  return { status: response.status, body: (await response.json()) as { result?: { by: string } } };
}
async function status(response: Promise<Response>) {
  const value = await response;
  await value.body?.cancel();
  return value.status;
}
/** Readiness refuses for the current boot only, as a runtime that went bad and stays bad. */
function refuseCurrentBoot(f: Fixture) {
  const boot = f.old.identity().bootId;
  f.old.hooks.health = async () =>
    f.old.identity().bootId === boot ? new Response(null, { status: 503 }) : undefined;
}

test(
  "a healthy fenced root unfences with its proof, at once",
  { timeout: 20_000 },
  async (context) => {
    const { f, identity } = await root(context);
    await f.send("fence", { identity });
    assert.equal((await selection(f)).active.fenced, true);
    const { status: code, body } = await unfence(f, identity);
    assert.equal(code, 200);
    assert.equal(body.result?.by, "proof");
    const { active } = await selection(f);
    assert.equal(active.fenced, false);
    assert.deepEqual(
      { by: active.unfenced?.by, proven: active.unfenced?.proven },
      { by: "proof", proven: true },
    );
    assert.equal(await status(f.model()), 200);
  },
);

test(
  "a refusing root fenced for less than every lease it could hold keeps its fence",
  {
    timeout: 20_000,
  },
  async (context) => {
    const { f, identity, advance } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    advance(unfenceHandBackAfterMs - 1);
    const { status: code } = await unfence(f, identity);
    assert.equal(code, 409);
    assert.equal((await selection(f)).active.fenced, true);
  },
);

test(
  "a fence recorded before its age was kept still needs the proof",
  {
    timeout: 20_000,
  },
  async (context) => {
    const { f, identity, advance } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    // A selection written by code that didn't record when it fenced: its age is unknown.
    const stored = (await f.old.storage.get(slotSelectionKey)) as { active: Slot };
    delete stored.active.fencedAt;
    await f.old.storage.put(slotSelectionKey, stored);
    advance(10 * unfenceHandBackAfterMs);
    const { status: code } = await unfence(f, identity);
    assert.equal(code, 409);
    assert.equal((await selection(f)).active.fenced, true);
  },
);

test(
  "a refusing root fenced past every lease goes back to recovery, which restarts it",
  {
    timeout: 30_000,
  },
  async (context) => {
    const { f, identity, advance } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    advance(unfenceHandBackAfterMs);
    const { status: code, body } = await unfence(f, identity);
    assert.equal(code, 200);
    assert.equal(body.result?.by, "recovery");
    const before = await selection(f);
    assert.equal(before.active.fenced, false);
    assert.deepEqual(
      { by: before.active.unfenced?.by, proven: before.active.unfenced?.proven },
      { by: "recovery", proven: false },
    );
    assert.equal(await status(f.model()), 503, "it serves nothing until it is proven");
    for (let elapsed = 0; elapsed <= unservingBoundMs; elapsed += 2_000) {
      await pass(f);
      advance(2_000);
    }
    await pass(f);
    assert.deepEqual(f.old.calls.signals, [15], "recovery's forced restart replaced it");
    const after = await selection(f);
    assert.equal(after.epoch, before.epoch + 1);
    assert.notEqual(after.active.identity?.bootId, identity.bootId);
    assert.equal(after.active.unfenced?.proven, true, "its new boot took current policies");
    assert.equal(await status(f.model()), 200);
  },
);

test(
  "a boot handed back that answers again serves only once current policies reach it",
  {
    timeout: 20_000,
  },
  async (context) => {
    const { f, identity, advance } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    advance(unfenceHandBackAfterMs);
    assert.equal((await unfence(f, identity)).body.result?.by, "recovery");
    // The refusal was a moment's: the old boot answers again right after the unfence, but current
    // policies can't reach it yet.
    f.old.hooks.health = async () => {};
    let installsFail = true;
    f.old.hooks.install = async () => {
      if (installsFail) throw new Error("synthetic install failure");
    };
    assert.equal(await status(f.model()), 503, "not before current policies reach it");
    assert.equal(await status(f.command("active-health")), 409);
    await pass(f);
    assert.equal((await selection(f)).active.unfenced?.proven, false, "still unproven");
    installsFail = false;
    await pass(f);
    assert.equal((await selection(f)).active.unfenced?.proven, true);
    assert.equal(await status(f.model()), 200);
    assert.deepEqual(f.old.calls.signals, [], "a boot that answers is never stopped");
    assert.equal(f.old.calls.start, 0);
  },
);
