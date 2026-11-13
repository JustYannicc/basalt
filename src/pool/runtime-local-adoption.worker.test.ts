import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";

test("release bootstrap preserves the local Root before any remote application exists", async (context) => {
  const f = await handoffWorker({
    adopt: false,
    bindings: { PoolRuntime: undefined, POOL_RUNTIME_APPLICATION_ID: undefined },
  });
  context.after(() => f.cleanup());
  const adopted = await f.command("adopt", { proof: f.preservation.envelope });
  assert.equal(adopted.status, 200, await adopted.clone().text());
  f.advanceCurrentBindings({
    POOL_MANAGEMENT_KEY: "future-management-key",
    POOL_IMAGE_HASH: "3".repeat(16),
  });
  const response = await f.model();
  assert.equal(response.status, 200);
  await response.body?.cancel();
  assert.equal((await f.view()).response.status, 200);
  f.reconstruct(false);
  assert.equal((await f.model()).status, 200);
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
});
