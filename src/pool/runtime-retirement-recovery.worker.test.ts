import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { RuntimeActivity } from "./runtime-slots/activity.ts";

for (const fault of ["before", "after"] as const) {
  test(
    `retirement ${fault} dispatch recovers after Root reconstruction with exactly one destruction`,
    { timeout: 10_000 },
    async (context) => {
      let now = Date.now();
      context.mock.method(Date, "now", () => now);
      const f = await fleetWorkerFixture();
      const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
      const arrived = deferred();
      const requests: Promise<Response>[] = [];
      context.after(async () => {
        for (const body of bodies) {
          try {
            body.close();
          } catch {}
        }
        await Promise.allSettled(requests);
        await f.cleanup();
      });
      f.onModel(async (_runtime, request) =>
        new URL(request.url).searchParams.has("held")
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(body) {
                  bodies.push(body);
                  if (bodies.length === 2) arrived.resolve();
                },
              }),
            )
          : new Response("public-terminal"),
      );
      await f.bootstrap();
      const configured = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
        await f.send("fleet-configure", { operationId: "enable", configuration: f.configuration }),
      );
      for (let index = 0; index < 2; index++)
        requests.push(f.model(new Request(`https://pool.invalid/v1/models?held=${index}`)));
      await arrived.promise;
      const ready = f.resourcesWhen((rows) => rows.length === 1 && rows[0]?.phase === "ready");
      now += 101;
      await f.upkeep();
      const [row] = await ready;
      const identity = row!.identity!;
      const target = f.instances.get(identity.instanceId)!;
      const fetch = target.worker.fetch.bind(target.worker);
      let injected = 0;
      target.worker.fetch = async (request) => {
        if (new URL(request.url).pathname !== "/retire" || injected) return fetch(request);
        injected++;
        if (fault === "after") await fetch(request);
        throw new Error(`synthetic retirement ${fault} dispatch`);
      };
      await f.send("fleet-disable", {
        operationId: "drain-all",
        expectedDigest: configured.digest,
      });
      await f.upkeep();
      await f.upkeep();
      assert.equal(injected, 1);
      const state = new RuntimeFleetState(f.old.storage, 4);
      assert.equal((await state.inspect())[0]?.phase, "retiring");
      assert.equal((await state.inspect())[0]?.active, 0);
      assert.equal(
        (await new RuntimeActivity(target.fixture.storage).inspect(identity))?.active,
        0,
      );
      assert.equal(target.fixture.calls.destroy, fault === "before" ? 0 : 1);
      f.reconstruct();
      for (let cycle = 0; cycle < 3; cycle++) await f.upkeep();
      assert.deepEqual(await state.inspect(), []);
      assert.equal(target.fixture.calls.destroy, 1);
      assert.equal(target.fixture.ctx.container.running, false);
      assert.equal(await (await f.model()).text(), "public-terminal");
    },
  );
}
