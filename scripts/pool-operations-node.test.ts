import assert from "node:assert/strict";
import { test } from "node:test";
import { nodePoolOperations } from "./pool-operations-node.ts";

test("private operations cross the Node IPC boundary without changing bodies or statuses", async () => {
  const platform = await nodePoolOperations(
    "synthetic-account",
    "synthetic-worker",
    new URL("./release-barrier/test/node-operations-peer.mjs", import.meta.url),
  );
  try {
    const health = await platform.env.POOL_OPERATIONS.fetch(
      new Request("http://pool-operations/runtime-recovery"),
    );
    assert.deepEqual(await health.json(), { node: true });
    const readiness = await platform.env.POOL_OPERATIONS.fetch(
      new Request("http://pool-operations/deployment-readiness", {
        method: "POST",
        body: "synthetic-signed-body",
      }),
    );
    assert.equal(await readiness.text(), "synthetic-signed-body");
    const refused = await platform.env.POOL_OPERATIONS.fetch(
      new Request("http://pool-operations/unready"),
    );
    assert.equal(refused.status, 503);
  } finally {
    await platform.dispose();
  }
  await assert.rejects(
    platform.env.POOL_OPERATIONS.fetch(new Request("http://pool-operations/runtime-recovery")),
    /closed/u,
  );
});
