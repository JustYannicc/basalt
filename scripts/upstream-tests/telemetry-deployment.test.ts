import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import { telemetryBindings } from "../../src/telemetry/deployment.ts";

test("telemetry bindings preserve the configured region and omit absent settings", async () => {
  const configured = await Effect.runPromise(telemetryBindings.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
      POSTHOG_HOST: "https://us.i.posthog.com", POSTHOG_PROJECT_KEY: "synthetic",
    })),
  ));
  assert.equal(Redacted.value(configured.POSTHOG_HOST!), "https://us.i.posthog.com");
  assert.equal(Redacted.value(configured.POSTHOG_PROJECT_KEY!), "synthetic");
  assert.equal(configured.SENTRY_DSN, undefined);
  const absent = await Effect.runPromise(telemetryBindings.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ POSTHOG_HOST: "" })),
  ));
  assert.deepEqual(absent, {});
});
