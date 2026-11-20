import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { unservingBoundMs } from "./runtime-slots/forced-restart-timing.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";
import { PoolAlarms } from "./alarms.ts";
import { membershipTtlMs } from "./membership-contract.ts";
import { policyHealthHeader } from "./runtime-health.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Slot {
  fenced: boolean;
  fencedAt?: number;
  unfenced?: { by: string; at: number; proven: boolean };
  identity?: { bootId: string };
}
interface Unfenced {
  result?: { by: string; cause?: string; recovery?: { restarts: number[]; needsPerson?: unknown } };
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
/** The Home upkeep, whose membership pass renews what failed installs held back. */
async function homePass(f: Fixture) {
  await new PoolAlarms(f.old.storage).schedule("home", Date.now());
  await f.alarm();
  await f.settle();
}
async function selection(f: Fixture) {
  return ((await f.send("inspect")) as { selection: { epoch: number; active: Slot } }).selection;
}
async function unfence(f: Fixture, identity: ReturnType<Fixture["old"]["identity"]>) {
  const response = await f.command("unfence", { identity });
  return { status: response.status, body: (await response.json()) as Unfenced };
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
    const fenced = await selection(f);
    assert.equal(fenced.active.fenced, true);
    assert.equal(typeof fenced.active.fencedAt, "number", "the operator sees when it was fenced");
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
  "a refusing root goes back to recovery at once and serves only on its proven new boot",
  {
    timeout: 30_000,
  },
  async (context) => {
    const { f, identity, advance } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    const { status: code, body } = await unfence(f, identity);
    assert.equal(code, 200);
    assert.deepEqual(
      { by: body.result?.by, cause: body.result?.cause },
      { by: "recovery", cause: "runtime" },
    );
    assert.deepEqual(body.result?.recovery?.needsPerson, undefined, "the reply shows the recovery");
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
    const { f, identity } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    assert.equal((await unfence(f, identity)).body.result?.by, "recovery");
    // The refusal was a moment's: the old boot answers again right after the unfence, but current
    // policies can't reach it yet.
    f.old.hooks.health = async () => {};
    let installsFail = true;
    f.old.hooks.install = async () => {
      if (installsFail) throw new Error("synthetic install failure");
    };
    assert.equal(await status(f.model()), 503, "not before current policies reach it");
    assert.equal(await status(f.command("active-health")), 409, "nor reported as serving");
    await pass(f);
    assert.equal((await selection(f)).active.unfenced?.proven, false, "still unproven");
    installsFail = false;
    await pass(f);
    assert.equal((await selection(f)).active.unfenced?.proven, true);
    await homePass(f);
    const served = await f.model();
    assert.equal(served.status, 200, await served.text());
    assert.deepEqual(f.old.calls.signals, [], "a boot that answers is never stopped");
    assert.equal(f.old.calls.start, 0);
  },
);

test(
  "a fence recorded before its time was kept is handed back too",
  {
    timeout: 20_000,
  },
  async (context) => {
    const { f, identity } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    const stored = (await f.old.storage.get(slotSelectionKey)) as { active: Slot };
    delete stored.active.fencedAt;
    await f.old.storage.put(slotSelectionKey, stored);
    const { status: code, body } = await unfence(f, identity);
    assert.equal(code, 200);
    assert.equal(body.result?.by, "recovery");
    assert.equal((await selection(f)).active.unfenced?.proven, false);
  },
);

test(
  "a fence again while unproven, then a passing proof, ends proven",
  {
    timeout: 20_000,
  },
  async (context) => {
    const { f, identity } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    assert.equal((await unfence(f, identity)).body.result?.by, "recovery");
    await f.send("fence", { identity });
    assert.equal((await selection(f)).active.fenced, true);
    assert.equal((await selection(f)).active.unfenced, undefined, "a fence clears the hand-back");
    f.old.hooks.health = async () => {};
    assert.equal((await unfence(f, identity)).body.result?.by, "proof");
    const { active } = await selection(f);
    assert.deepEqual(
      { fenced: active.fenced, by: active.unfenced?.by, proven: active.unfenced?.proven },
      { fenced: false, by: "proof", proven: true },
    );
    assert.equal(await status(f.model()), 200);
  },
);

test(
  "a fence committed mid-restart, then unfenced, serves only on the committed new boot",
  {
    timeout: 30_000,
  },
  async (context) => {
    const { f, identity } = await root(context);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    context.after(() => release.resolve());
    // The 19 Nov shape: a restart is booting when the fence lands.
    f.old.hooks.health = async () => {
      if (f.old.calls.start) {
        entered.resolve();
        await release.promise;
      }
    };
    f.old.crash();
    await f.upkeep();
    await entered.promise;
    await f.send("fence", { identity });
    release.resolve();
    await f.settle();
    const fenced = await selection(f);
    assert.equal(fenced.active.fenced, true);
    assert.equal(
      fenced.active.identity?.bootId,
      identity.bootId,
      "the fence held the old selection",
    );
    const { body } = await unfence(f, identity);
    assert.equal(body.result?.by, "recovery");
    assert.equal(await status(f.model()), 503, "not before the restart commits its proven boot");
    await pass(f);
    await pass(f);
    const after = await selection(f);
    assert.equal(after.epoch, fenced.epoch + 1);
    assert.notEqual(after.active.identity?.bootId, identity.bootId);
    assert.equal(after.active.unfenced?.proven, true);
    const served = await f.model();
    assert.equal(served.status, 200, await served.text());
  },
);

test(
  "a runtime that answers health but refuses current policies goes back to recovery, unproven",
  {
    timeout: 20_000,
  },
  async (context) => {
    const { f, identity } = await root(context);
    await f.send("fence", { identity });
    f.old.hooks.install = async () => {
      throw new Error("synthetic install failure");
    };
    // It can't take current policies, so it can't serve: recovery replaces it, never routes to it.
    const { status: code, body } = await unfence(f, identity);
    assert.equal(code, 200);
    assert.equal(body.result?.by, "recovery");
    assert.equal((await selection(f)).active.unfenced?.proven, false);
    assert.equal(await status(f.model()), 503);
  },
);

/** A fence held past every clean lease: membership can't renew through a fenced slot. */
async function fencedPastLeases(f: Fixture, advance: (milliseconds: number) => void) {
  for (let elapsed = 0; elapsed <= 3 * membershipTtlMs; elapsed += 5_000) {
    await homePass(f);
    advance(5_000);
  }
}

test(
  "a healthy root fenced past its leases goes back unproven and is proven through Home",
  { timeout: 20_000 },
  async (context) => {
    const { f, identity, advance } = await root(context);
    await f.send("fence", { identity });
    await fencedPastLeases(f, advance);
    const { status: code, body } = await unfence(f, identity);
    assert.equal(code, 200);
    assert.deepEqual(
      { by: body.result?.by, cause: body.result?.cause },
      { by: "recovery", cause: "leases" },
      "no proof passes on leases the fence let run out",
    );
    assert.equal((await selection(f)).active.unfenced?.proven, false);
    assert.equal(await status(f.model()), 503, "no model call before current policies reach it");
    const home = f.old.calls.home;
    await homePass(f);
    assert.ok(f.old.calls.home > home, "membership's Home read reached the unproven boot");
    await pass(f);
    assert.equal((await selection(f)).active.unfenced?.proven, true);
    const served = await f.model();
    assert.equal(served.status, 200, await served.text());
    assert.deepEqual(f.old.calls.signals, [], "a boot that answers is never stopped");
    assert.equal(f.old.calls.start, 0);
  },
);

test(
  "a refusing root fenced past its leases goes back to recovery and serves on its new boot",
  { timeout: 30_000 },
  async (context) => {
    const { f, identity, advance } = await root(context);
    refuseCurrentBoot(f);
    await f.send("fence", { identity });
    await fencedPastLeases(f, advance);
    const { body } = await unfence(f, identity);
    assert.equal(body.result?.cause, "leases");
    for (let elapsed = 0; elapsed <= unservingBoundMs; elapsed += 2_000) {
      await pass(f);
      advance(2_000);
    }
    await pass(f);
    assert.deepEqual(f.old.calls.signals, [15], "recovery's forced restart replaced it");
    // The committed boot is proven; its expired lease holds recovery until Home renews it.
    await homePass(f);
    await pass(f);
    const after = await selection(f);
    assert.notEqual(after.active.identity?.bootId, identity.bootId);
    assert.equal(after.active.unfenced?.proven, true);
    const served = await f.model();
    assert.equal(served.status, 200, await served.text());
  },
);

test(
  "an unproven boot takes no Home call and no model call while another boot answers for it",
  { timeout: 20_000 },
  async (context) => {
    const { f, identity, advance } = await root(context);
    await f.send("fence", { identity });
    await fencedPastLeases(f, advance);
    assert.equal((await unfence(f, identity)).body.result?.by, "recovery");
    // A container answering readiness as a boot the selection never attested.
    f.old.hooks.health = async () =>
      Response.json(
        { boot_id: crypto.randomUUID(), started_at: "fixture-started" },
        { headers: { [policyHealthHeader]: "1500" } },
      );
    const home = f.old.calls.home;
    const models = f.old.calls.model;
    await homePass(f);
    assert.equal(await status(f.model()), 503);
    assert.equal(f.old.calls.home, home, "no Home call reached it");
    assert.equal(f.old.calls.model, models, "no model call reached it");
    assert.equal((await selection(f)).active.unfenced?.proven, false);
  },
);

for (const [path, refuses] of [
  ["its proof", false],
  ["its hand-back to recovery", true],
] as const)
  test(
    `a fence that lands during an unfence's proof wins over ${path}`,
    { timeout: 20_000 },
    async (context) => {
      const { f, identity, advance } = await root(context);
      await f.send("fence", { identity });
      const first = (await selection(f)).active.fencedAt;
      let fenced = false;
      // A second operator fences while the first one's proof reads health.
      f.old.hooks.health = async () => {
        if (!fenced) {
          fenced = true;
          advance(1_000);
          await f.send("fence", { identity });
        }
        return refuses ? new Response(null, { status: 503 }) : undefined;
      };
      const { status: code } = await unfence(f, identity);
      assert.equal(code, 409);
      const { active } = await selection(f);
      assert.equal(active.fenced, true, "the second fence holds");
      assert.notEqual(active.fencedAt, first);
      assert.equal(active.unfenced, undefined);
    },
  );
