import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";

test(
  "a cell that turns not ready after the controller sent the call answers unsent, never outcome-unknown",
  { timeout: 15_000 },
  async (context) => {
    context.mock.method(console, "error", () => {});
    const f = await fleetWorkerFixture();
    let held: Response | undefined;
    context.after(async () => {
      await held?.body?.cancel();
      await f.cleanup();
    });
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "unsent-refusal",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    const initial = await f.model();
    await initial.body?.cancel();
    await f.settle();
    const [sibling] = await f.resourcesWhen((rows) => rows.some((row) => row.phase === "ready"));
    assert.ok(sibling?.identity);
    const cell = f.instances.get(sibling.identity.instanceId);
    assert.ok(cell);
    // A call the root holds open makes the cell the next call's runtime whichever way the fleet
    // ranks the root; with cells first it simply lands on the cell.
    f.onModel(async (instance) =>
      instance === f.old
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("held"));
              },
            }),
          )
        : undefined,
    );
    held = await f.model();
    const models = cell.fixture.calls.model;
    const keepAlives = cell.fixture.calls.keepAlive;
    // The router's own readiness read passes. The endpoint's read just before its container send,
    // which follows its keep-alive, refuses, as when a cell flips to not ready with a call admitted.
    cell.fixture.hooks.health = async () => {
      if (cell.fixture.calls.keepAlive > keepAlives) return new Response(null, { status: 503 });
    };
    const response = await f.model(
      new Request("http://pool/v1/messages", { method: "POST", body: "{}" }),
    );
    assert.equal(cell.fixture.calls.model, models, "no byte reached the cell's container");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "1");
    assert.equal(response.headers.get("X-Signalbox-Controller-Unsent"), "1");
    await response.body?.cancel();
  },
);
