import assert from "node:assert/strict";
import { test } from "node:test";
import { rehearsalObservationEnv } from "./rehearsal-observation-env.ts";

test("production's store binding and every other binding pass through untouched", () => {
  const store = { get: async () => "from-the-store" };
  const env = { POOL_PROVIDER_OBSERVATION_TOKEN: store, POOL_MANAGEMENT_KEY: "k" };
  assert.equal(rehearsalObservationEnv(env), env);
  const none = { POOL_MANAGEMENT_KEY: "k" };
  assert.equal(rehearsalObservationEnv(none), none);
});

test("a plain observation secret is read through the store binding's shape, and nothing else changes", async () => {
  const database = {};
  const env = rehearsalObservationEnv({
    POOL_PROVIDER_OBSERVATION_TOKEN: "plain-secret" as unknown,
    POOL_MANAGEMENT_KEY: "k",
    POOL_AUTH_DATABASE: database,
  });
  const token = env.POOL_PROVIDER_OBSERVATION_TOKEN as { get(): Promise<string | null> };
  assert.equal(typeof token, "object");
  assert.equal(await token.get(), "plain-secret");
  assert.equal(env.POOL_MANAGEMENT_KEY, "k");
  assert.equal(env.POOL_AUTH_DATABASE, database);
  assert.ok("POOL_AUTH_DATABASE" in env);
});
