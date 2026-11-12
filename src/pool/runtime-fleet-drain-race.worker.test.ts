import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { fleetStageState } from "../../scripts/scale-test/fleet/state.ts";

test(
  "planned drain preserves a public request reserved before its endpoint dispatch",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    const healthEntered = deferred(),
      healthRelease = deferred(),
      modelEntered = deferred(),
      headersRelease = deferred();
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const responses: Response[] = [];
    let dispatches = 0;
    let routed: Promise<Response> | undefined, draining: Promise<void> | undefined;
    context.after(async () => {
      healthRelease.resolve();
      headersRelease.resolve();
      for (const body of bodies) {
        try {
          body.close();
        } catch {}
      }
      await Promise.allSettled([routed, draining]);
      for (const response of responses) await response.body?.cancel();
      await f.cleanup();
    });
    f.onModel(async (_instance, request) => {
      if (new URL(request.url).searchParams.get("id") === "racing") {
        dispatches++;
        modelEntered.resolve();
        await headersRelease.promise;
        return new Response("terminal:racing");
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodies.push(controller);
          },
        }),
      );
    });
    await f.bootstrap();
    const enabled = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", {
        operationId: "enable-race",
        configuration: f.configuration,
      }),
    );
    for (let index = 0; index < 4; index++)
      responses.push(
        await f.model(new Request(`https://pool.invalid/v1/models?id=legacy-${index}`)),
      );
    const ready = f.resourcesWhen(
      (rows) => rows.length === 2 && rows.every((row) => row.phase === "ready"),
    );
    now += 101;
    await f.upkeep();
    const rows = await ready;
    const identity = rows[0]!.identity!;
    const instance = f.instances.get(identity.instanceId)!;
    let blocked = false;
    instance.fixture.hooks.health = async () => {
      if (!blocked) {
        blocked = true;
        healthEntered.resolve();
        await healthRelease.promise;
      }
    };
    routed = f.model(new Request("https://pool.invalid/v1/models?id=racing"));
    await healthEntered.promise;
    const reserved = await fleetStageState(identity, {
      root: f.old.storage,
      endpoint: instance.fixture.storage,
    });
    assert.equal(reserved.root?.active, 1);
    assert.equal(reserved.endpoint?.activity?.active, 0);
    await f.send("fleet-disable", { operationId: "disable-race", expectedDigest: enabled.digest });
    const fenced = f.resourcesWhen((rows) =>
      rows.some((row) => row.target.instanceId === identity.instanceId && row.phase === "draining"),
    );
    draining = f.upkeep();
    await fenced;
    healthRelease.resolve();
    const arrival = await Promise.race([
      modelEntered.promise.then(() => "dispatched"),
      routed.then((response) => `response:${response.status}`),
    ]);
    assert.equal(
      arrival,
      "dispatched",
      "A planned drain must not reject an already reserved public request",
    );
    await draining;
    const held = await fleetStageState(identity, {
      root: f.old.storage,
      endpoint: instance.fixture.storage,
    });
    assert.equal(held.root?.active, 1);
    assert.equal(held.endpoint?.activity?.phase, "draining");
    assert.equal(held.endpoint?.activity?.active, 1);
    assert.equal(held.endpoint?.activity?.known, true);
    assert.equal(instance.fixture.calls.destroy, 0);
    headersRelease.resolve();
    const response = await routed;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "terminal:racing");
    assert.equal(dispatches, 1);
  },
);
