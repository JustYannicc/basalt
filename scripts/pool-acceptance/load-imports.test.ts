import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dependents, importGraph } from "../ci/import-graph.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Everything the load job loads, from the entry its workflow starts, through CI's import graph. */
function loadClosure() {
  const { importers } = importGraph(root);
  const imports = new Map<string, Set<string>>();
  for (const [target, from] of importers)
    for (const importer of from) {
      if (!imports.has(importer)) imports.set(importer, new Set());
      imports.get(importer)!.add(target);
    }
  return dependents(imports, ["scripts/pool-acceptance.ts"]);
}

test("the load reads the test device's secret without loading the pool's setup code", () => {
  const closure = loadClosure();
  assert.ok(closure.has("scripts/pool-acceptance/load-entry.ts"));
  assert.ok(closure.has("scripts/release/acceptance-test-device-secret.ts"));
  // Registering a device needs the pool's setup links; only the registration workflow loads them.
  assert.ok(!closure.has("scripts/release/acceptance-test-device.ts"), "the registration script");
  assert.ok(!closure.has("src/pool/setup-links.ts"), "the pool's setup links");
  const setup = [...closure].filter((file) => file.startsWith("src/setup/"));
  assert.deepEqual(setup, [], "the setup service's own source");
});
