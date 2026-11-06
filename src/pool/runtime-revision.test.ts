import assert from "node:assert/strict";
import { test } from "node:test";

// The production adapter only needs the container API; Node has no Workers global types.
const runtimeModule = "./runtime.worker.ts";
const {
  createPoolLifecycle,
}: {
  createPoolLifecycle(ctx: object, env: object): Promise<{ warm(): Promise<unknown> }>;
} = await import(runtimeModule);

test("the provisioned schema owner changes the runtime revision once and reaches Home startup", async () => {
  const env = {
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-management",
    POOL_IMAGE_HASH: "fixture-image",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_DEPLOYMENT_KEY: "cd".repeat(32),
  };
  const legacyInput = JSON.stringify([
    env.POOL_DATABASE_URL,
    env.POOL_MANAGEMENT_KEY,
    env.POOL_IMAGE_HASH,
    env.POOL_APP_SIGNING_KEY,
    null,
  ]);
  const legacyRevision = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacyInput)),
  ).toString("hex");
  const values = new Map<string, string>([["revision", legacyRevision]]);
  let running = true;
  let starts = 0;
  let stops = 0;
  let startedEnvironment: Record<string, string> = {};
  const context = {
    container: {
      get running() {
        return running;
      },
      start(options: { env: Record<string, string> }) {
        starts++;
        running = true;
        startedEnvironment = options.env;
      },
      async destroy() {
        stops++;
        running = false;
      },
      async setInactivityTimeout() {},
      getTcpPort() {
        return {
          async fetch() {
            return Response.json({ boot_id: "fixture-boot", started_at: "2026-11-06T00:00:00Z" });
          },
        };
      },
    },
    storage: {
      async get(key: string) {
        return values.get(key);
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async getAlarm() {
        return null;
      },
      async setAlarm() {},
    },
  };
  await (await createPoolLifecycle(context, env)).warm();
  assert.equal(startedEnvironment.POOL_DATABASE_SCHEMA_OWNER, "basalt_pool_owner");
  assert.equal(starts, 1);
  assert.equal(stops, 1, "A container on the old owner-less configuration must restart");
  assert.notEqual(values.get("revision"), legacyRevision);
  env.POOL_DEPLOYMENT_KEY = "ef".repeat(32);
  await (await createPoolLifecycle(context, env)).warm();
  assert.equal(starts, 1, "The unchanged owner configuration must reuse the running container");
  assert.equal(stops, 1);
});
