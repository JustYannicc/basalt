import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { readSuspect } from "./runtime-fleet/failure-record.ts";

interface Inspected {
  resources: { phase: string; reason?: string; target: { slotId: string }; suspect?: unknown }[];
}

test("a readiness refusal during the Home pass's install fences the cell instead of quarantining it, takes no call meanwhile, and is no longer fenced once the install lands", async (context) => {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  context.mock.method(console, "error", () => {});
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "install-fence",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const response = await f.model();
  assert.equal(response.status, 200);
  await response.body?.cancel();
  await f.settle();
  const [ready] = await f.resourcesWhen((rows) => rows.some((value) => value.phase === "ready"));
  assert.ok(ready);
  const cell = f.instances.get(ready.target.instanceId)!.fixture;
  const healthy = cell.hooks.health;
  const served: string[] = [];
  f.onModel(async (instance) => {
    served.push(instance.target.instanceId);
    return new Response("served");
  });
  const row = async () =>
    ((await f.send("fleet-inspect")) as Inspected).resources.find(
      (value) => value.target.slotId === ready.target.slotId,
    );
  // Each pass 6 s on, so the membership pass is due and installs the pool's policy on the cell.
  const pass = async () => {
    now += 6_000;
    await f.upkeep();
    await f.settle();
  };
  cell.hooks.health = async () => new Response(null, { status: 503 });
  await pass();
  const fenced = await row();
  assert.equal(fenced?.phase, "ready", `the refused install removed the cell (${fenced?.reason})`);
  assert.ok(readSuspect(fenced?.suspect)?.policyOwed?.length, "the cell owes no policy");
  const during = await f.model();
  assert.equal(during.status, 200);
  await during.body?.cancel();
  assert.ok(!served.includes(ready.target.instanceId), "a call reached the fenced cell");
  cell.hooks.health = healthy;
  for (let index = 0; index < 3 && (await row())?.suspect !== undefined; index++) await pass();
  const after = await row();
  assert.equal(after?.phase, "ready");
  assert.equal(after?.suspect, undefined, "the cell stayed fenced after the install landed");
});
