import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelLifetimeFixture } from "../../scripts/pool-tests/model-lifetime-fixture.ts";
import { modelLifetimeFetch } from "./model-lifetime.worker.ts";
import { failureFleetFixture } from "../../scripts/pool-tests/runtime-fleet-failure-fixture.ts";
import { installWorkerSockets, upgraded } from "../../scripts/pool-tests/native-sockets.ts";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";

for (const outcome of ["commit", "reject"] as const) {
  test(
    `an upgraded failure retains its reservation until quarantine can ${outcome}`,
    { timeout: 5_000 },
    async (context) => {
      const restore = installWorkerSockets();
      context.after(restore);
      const f = await failureFleetFixture(1),
        identity = await f.add();
      let entered = false;
      const fence = deferred(),
        settled = deferred(),
        released = deferred();
      f.memory.afterCommit = () => {
        void f.state.inspect().then((rows) => {
          if (rows[0]?.active === 0) released.resolve();
        });
      };
      const sockets = new ModelLifetimeFixture();
      context.after(() => sockets.close());
      const quarantine = f.state.quarantine.bind(f.state);
      context.mock.method(
        f.state,
        "quarantine",
        async (value: Parameters<typeof quarantine>[0]) => {
          entered = true;
          try {
            await fence.promise;
            return await quarantine(value);
          } finally {
            settled.resolve();
          }
        },
      );
      f.cell(identity).forward = async (request, _port, _pool, before) =>
        modelLifetimeFetch(
          new Request(request, { headers: { Upgrade: "websocket" } }),
          async (request) => sockets.fetch(request),
          before,
        );
      const abort = new AbortController();
      const client = upgraded(await f.forward(abort.signal));
      const closed = deferred<number>();
      client.addEventListener("close", (event) => closed.resolve(event.code), { once: true });
      sockets.breakControl();
      assert.equal(await closed.promise, 1011);
      assert.equal(entered, true);
      await f.settle();
      assert.equal((await f.state.inspect())[0]?.active, 1);
      assert.equal((await f.state.inspect())[0]?.phase, "ready");
      abort.abort();
      assert.equal((await f.state.inspect())[0]?.active, 1);
      if (outcome === "commit") fence.resolve();
      else fence.reject(new Error("synthetic quarantine write unavailable"));
      await settled.promise;
      if (outcome === "commit") await released.promise;
      await f.settle();
      assert.equal((await f.state.inspect())[0]?.active, outcome === "commit" ? 0 : 1);
      assert.equal(
        (await f.state.inspect())[0]?.phase,
        outcome === "commit" ? "quarantined" : "ready",
      );
      assert.equal(f.legacyCalls(), 0);
    },
  );
}
