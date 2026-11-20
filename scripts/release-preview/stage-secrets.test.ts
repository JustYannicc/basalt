import assert from "node:assert/strict";
import { test } from "node:test";
import { secretsInventory } from "./stage-secrets.ts";

test("secretsInventory keeps store and secret names only, and names the observation secrets", () => {
  const stores = [{ id: "s1", name: "default_secrets_store", created: "x" }];
  const secrets = new Map([
    [
      "s1",
      [
        { name: "basalt-production-pool-provider-observation", id: "a", value: "never" },
        { name: "other", id: "b" },
      ],
    ],
  ]);
  const inventory = secretsInventory(stores, secrets, "test-rehearsal-2");
  assert.deepEqual(inventory, {
    stores: 1,
    secrets: 2,
    rows: [
      {
        store: "default_secrets_store",
        secrets: ["basalt-production-pool-provider-observation", "other"],
        productionObservation: true,
        stageObservation: false,
      },
    ],
  });
  assert.ok(!JSON.stringify(inventory).includes("never"));
});
