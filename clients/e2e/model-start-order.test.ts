import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { deferred } from "./remote-fixture.ts";
import { profileGate } from "./profile-gate.ts";
import { command, fixtureHome } from "./support.ts";

for (const action of ["cancel", "disconnect", "sign-out"] as const) {
  test(`${action} while reading a profile prevents orphan model dispatch`, async (t) => {
    const received: number[] = [];
    const freshReceived = deferred<void>();
    const upstream = createServer(async (incoming, outgoing) => {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      received.push(JSON.parse(body).index);
      freshReceived.resolve();
      outgoing.end('{"id":"synthetic","status":"completed"}');
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const gate = await profileGate(profile.home);
    const gateway = await profile.start(gate.execArgv);
    const token = await profile.secret("models");
    t.after(async () => {
      await gate.release();
      await gateway.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile.remove();
    });
    const abort = new AbortController();
    const start = (index: number, held = false) =>
      fetch(`${gateway.origin}/v1/responses`, {
        method: "POST",
        signal: held ? abort.signal : undefined,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(held ? { "x-fixture-id": "held" } : {}),
        },
        body: JSON.stringify({ model: "synthetic", index }),
      });
    const pending = start(0, true);
    const cancelled =
      action === "cancel" ? assert.rejects(pending, { name: "AbortError" }) : undefined;
    await gate.held(gateway, "held");
    if (action === "cancel") {
      abort.abort();
      await cancelled;
      await gate.closed(gateway, "held");
    } else await command([action], profile.home);
    await gate.release();
    if (action !== "cancel") {
      const response = await pending;
      assert.equal(response.status, action === "sign-out" ? 401 : 503);
      await response.body?.cancel();
      if (action === "disconnect") await command(["reconnect"], profile.home);
    }
    if (action !== "sign-out") {
      const fresh = await start(1);
      assert.equal(fresh.status, 200);
      assert.equal(JSON.parse(await fresh.text()).status, "completed");
      await freshReceived.promise;
      assert.deepEqual(received, [1]);
    } else {
      const fresh = await start(1);
      assert.equal(fresh.status, 401);
      await fresh.body?.cancel();
      assert.deepEqual(received, []);
    }
  });
}
