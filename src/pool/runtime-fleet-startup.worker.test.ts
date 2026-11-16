import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

for (const reconstructed of [false, true])
  test(
    `upkeep ${reconstructed ? "recovers an unowned start after reconstruction" : "leaves a live startup owner to activate its cell"} before growing the second runtime`,
    { timeout: 15_000 },
    async (context) => {
      let now = Date.now();
      context.mock.method(Date, "now", () => now);
      const f = await fleetWorkerFixture();
      const reached = deferred();
      const release = deferred();
      const entered = deferred();
      const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
      const responses: Promise<Response>[] = [];
      context.after(async () => {
        release.resolve();
        for (const body of bodies) body.close();
        await Promise.allSettled(
          responses.map(async (response) => (await response).body?.cancel()),
        );
        await f.cleanup();
      });
      f.onRuntimeStartReply(async (runtime) => {
        if (runtime.target.homePeerOrdinal !== 1) return;
        reached.resolve();
        await release.promise;
      });
      f.onModel(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(body) {
                bodies.push(body);
                if (bodies.length === 4) entered.resolve();
              },
            }),
          ),
      );
      await f.bootstrap();
      await f.send("fleet-configure", {
        operationId: "two-owned-starts",
        configuration: { ...f.configuration, maximum: 2, targetActive: 1 },
      });
      for (let index = 0; index < 4; index++) responses.push(f.model());
      await entered.promise;
      await reached.promise;
      now += 101;
      if (reconstructed) f.reconstruct();
      await f.upkeep();
      const state = new RuntimeFleetState(f.old.storage, 4);
      const physicalCount = () =>
        [...f.instances.values()].filter(({ fixture }) => fixture.ctx.container.running).length;
      if (!reconstructed) {
        const warming = await state.inspect();
        assert.equal(warming.length, 1);
        assert.equal(warming[0]!.phase, "warming");
        assert.equal(physicalCount(), 1);
        release.resolve();
      }
      const ready = await f.resourcesWhen(
        (rows) => rows.length === 2 && rows.every((row) => row.phase === "ready"),
      );
      assert.equal(physicalCount(), 2);
      for (const row of ready) {
        assert.equal(f.instances.get(row.target.instanceId)!.fixture.calls.start, 1);
        assert.equal(f.instances.get(row.target.instanceId)!.fixture.calls.destroy, 0);
      }
    },
  );
