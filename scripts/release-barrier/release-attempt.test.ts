import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverStackDetails } from "../architecture/native-stack.ts";

test("the actual root Worker bindings omit attempt identity and limit the stable release key to PoolWorker", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { workers } = discoverStackDetails(root);
  assert.ok(workers.length > 1);
  assert.deepEqual(
    workers.filter((worker) =>
      worker.bindings.some((binding) => binding.name === "BASALT_RELEASE_ATTEMPT"),
    ),
    [],
  );
  assert.deepEqual(
    workers
      .filter((worker) => worker.bindings.some((binding) => binding.name === "POOL_DEPLOYMENT_KEY"))
      .map((worker) => worker.fqn),
    ["PoolWorker"],
  );
});
