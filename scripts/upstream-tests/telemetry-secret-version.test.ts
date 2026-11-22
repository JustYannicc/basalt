import assert from "node:assert/strict";
import { test } from "node:test";
import {
  axiomTelemetrySecret,
  directTelemetrySecret,
  frozenTelemetrySecretVersion,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/telemetry.ts";

// Byte for byte what the last released pin's telemetry bindings encode for these inputs. A changed
// EXECUTOR_TELEMETRY value makes Cloudflare refuse to roll a Worker back without force.
const released = {
  direct:
    '{"service":"executor-cloud","clock":"cloudflare-io","version":"f69c667936e4c02c75f9d7cc79fb750c230839b9","environment":"production","strictPrivacy":true,"traces":{"url":"https://sentry.invalid/otlp/v1/traces","headers":{"x-sentry-auth":"sentry sentry_key=synthetic"}}}',
  axiom:
    '{"service":"executor-cloud","clock":"cloudflare-io","version":"f69c667936e4c02c75f9d7cc79fb750c230839b9","environment":"production","traces":{"url":"https://axiom.invalid/v1/traces","headers":{"Authorization":"Bearer synthetic","X-Axiom-Dataset":"traces"}},"logs":{"url":"https://axiom.invalid/v1/logs","headers":{"Authorization":"Bearer synthetic","X-Axiom-Dataset":"logs"}},"metrics":{"url":"https://axiom.invalid/v1/metrics","headers":{"Authorization":"Bearer synthetic","X-Axiom-Dataset":"metrics"}}}',
};

const target = (path: string, dataset: string) => ({
  url: `https://axiom.invalid/v1/${path}`,
  headers: { Authorization: "Bearer synthetic", "X-Axiom-Dataset": dataset },
});

test("the telemetry secret keeps the released pin as its version, so a pin bump leaves it equal", () => {
  assert.equal(frozenTelemetrySecretVersion, "f69c667936e4c02c75f9d7cc79fb750c230839b9");
  assert.equal(
    directTelemetrySecret("production", {
      url: "https://sentry.invalid/otlp/v1/traces",
      headers: { "x-sentry-auth": "sentry sentry_key=synthetic" },
    }),
    released.direct,
  );
  assert.equal(
    axiomTelemetrySecret("production", {
      traces: target("traces", "traces"),
      logs: target("logs", "logs"),
      metrics: target("metrics", "metrics"),
    }),
    released.axiom,
  );
});
