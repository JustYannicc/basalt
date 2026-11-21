import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { roleHostRoutes } from "../../.upstream/apps/hosted/cloud/src/infrastructure/role-hosts.ts";

// Carry 0719: Basalt's disposable stages keep the `app` role host for their own router.
const routesFor = (env: Record<string, string>) =>
  Effect.runPromise(
    roleHostRoutes.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
  ) as Promise<{ routes?: { pattern: string }[] }>;

const stage = { ALCHEMY_STAGE: "test-rehearsal-4", TEST_STAGE_DOMAIN: "stage.example.test" };

test("unset, a test stage's API Worker routes every role host, exactly as upstream does", async () => {
  const patterns = (await routesFor(stage)).routes?.map((route) => route.pattern).sort();
  assert.deepEqual(patterns, [
    "api.rehearsal-4.stage.example.test/*",
    "app.rehearsal-4.stage.example.test/*",
    "mcp.rehearsal-4.stage.example.test/*",
  ]);
});

test("with Basalt's router on the app host, the API Worker keeps mcp and api and leaves app alone", async () => {
  const patterns = (await routesFor({ ...stage, EXECUTOR_APP_HOST_ROUTER: "basalt" })).routes
    ?.map((route) => route.pattern)
    .sort();
  assert.deepEqual(patterns, [
    "api.rehearsal-4.stage.example.test/*",
    "mcp.rehearsal-4.stage.example.test/*",
  ]);
});

test("production declares no role-host routes, with or without the switch", async () => {
  const production = { ALCHEMY_STAGE: "production", BETTER_AUTH_URL: "https://app.example.test" };
  for (const env of [production, { ...production, EXECUTOR_APP_HOST_ROUTER: "basalt" }])
    assert.deepEqual(await routesFor(env), {});
});
