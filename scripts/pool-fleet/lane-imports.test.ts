import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dependents, importGraph } from "../ci/import-graph.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Everything the fleet lane loads on a run, from the entry its workflow starts, through the same
 * import graph CI's selection reads.
 */
function laneClosure() {
  const { importers } = importGraph(root);
  const imports = new Map<string, Set<string>>();
  for (const [target, from] of importers)
    for (const importer of from) {
      if (!imports.has(importer)) imports.set(importer, new Set());
      imports.get(importer)!.add(target);
    }
  return dependents(imports, ["scripts/pool-fleet/dispatch.ts"]);
}

test("the fleet lane reads the test device's secret without loading the pool's setup code", () => {
  const closure = laneClosure();
  // The lane needs the test device's shape and the identity rule, which it does load.
  assert.ok(closure.has("scripts/pool-fleet/environment.ts"));
  assert.ok(closure.has("scripts/release/acceptance-test-device-secret.ts"));
  // Registering a device needs the pool's setup links; that code is never part of a lane run.
  assert.ok(!closure.has("scripts/release/acceptance-test-device.ts"), "the registration script");
  assert.ok(!closure.has("src/pool/setup-links.ts"), "the pool's setup links");
  const setup = [...closure].filter((file) => file.startsWith("src/setup/"));
  assert.deepEqual(setup, [], "the setup service's own source");
});
