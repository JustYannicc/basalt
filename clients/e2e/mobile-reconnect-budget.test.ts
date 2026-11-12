import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, fixture } from "./mobile-reconnect-fixture.ts";

test("a long outage recovers within twenty seconds without network or AppState events", async (t) => {
  const f = fixture(t);
  t.mock.method(Math, "random", () => 1);
  await f.controller.initialize();
  f.offline();
  const health = f.controller.checkHealth();
  await advance(t, 120_000);
  await health;

  // Restore the network just after a failed attempt, at the start of the longest backoff.
  const reads = f.reads();
  for (let elapsed = 0; elapsed < 31_000 && f.reads() === reads; elapsed += 50)
    await advance(t, 50);
  assert.ok(f.reads() > reads);
  await advance(t, 1300);
  f.online();
  await advance(t, 20_000);

  assert.equal(f.controller.getSnapshot().reconnecting, false);
  const transport = await f.controller.run(
    (source, signal) => source.transport(signal),
    new AbortController().signal,
  );
  assert.ok(transport.mode === "device");
  assert.deepEqual(transport.capabilities, ["models", "tools"]);
  await f.controller.close();
});
