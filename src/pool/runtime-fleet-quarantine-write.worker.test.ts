import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorEvent, WebSocketPair } from "miniflare";
import { failureFleetFixture } from "../../scripts/pool-tests/runtime-fleet-failure-fixture.ts";
import { installWorkerSockets, upgraded } from "../../scripts/pool-tests/native-sockets.ts";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";

for (const outcome of ["commit", "reject"] as const) {
  test(`an upgraded failure retains its reservation until quarantine can ${outcome}`, async (context) => {
    const restore = installWorkerSockets();
    context.after(restore);
    const f = await failureFleetFixture(1),
      identity = await f.add();
    const entered = deferred(),
      fence = deferred();
    const quarantine = f.state.quarantine.bind(f.state);
    context.mock.method(f.state, "quarantine", async (value: Parameters<typeof quarantine>[0]) => {
      entered.resolve();
      await fence.promise;
      return quarantine(value);
    });
    const pair = new WebSocketPair();
    pair[1].accept();
    f.cell(identity).forward = async (_request, _port, _pool, before) => {
      before();
      const init = { status: 101, webSocket: pair[0] };
      return new Response(null, init);
    };
    const client = upgraded(await f.forward());
    const closed = deferred<number>();
    client.addEventListener("close", (event) => closed.resolve(event.code), { once: true });
    pair[0].dispatchEvent(new ErrorEvent("error"));
    await entered.promise;
    await f.settle();
    assert.equal((await f.state.inspect())[0]?.active, 1);
    assert.equal((await f.state.inspect())[0]?.phase, "ready");
    if (outcome === "commit") fence.resolve();
    else fence.reject(new Error("synthetic quarantine write unavailable"));
    assert.equal(await closed.promise, 1011);
    await f.settle();
    assert.equal((await f.state.inspect())[0]?.active, outcome === "commit" ? 0 : 1);
    assert.equal(
      (await f.state.inspect())[0]?.phase,
      outcome === "commit" ? "quarantined" : "ready",
    );
    assert.equal(f.legacyCalls(), 0);
  });
}
