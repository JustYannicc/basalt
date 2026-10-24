import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const upstream = resolve(".upstream");
const cloud = resolve(upstream, "apps/hosted/cloud");
const requireCloud = createRequire(pathToFileURL(resolve(cloud, "package.json")));
const requireTelemetry = createRequire(pathToFileURL(resolve(upstream, "packages/telemetry/package.json")));
const { CloudflareClient } = requireCloud("@sentry/cloudflare");
const { createStackParser, createTransport, nodeStackLineParser } = requireCloud("@sentry/core");
const { Effect } = requireTelemetry("effect");
const { OtlpSerialization } = requireTelemetry("effect/observability");

const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);

test("direct Sentry beforeSend scrubs the actual serialized SDK envelope", async () => {
  const { sentryBeforeSend } = await load("apps/hosted/cloud/src/implementation/error-reporting.ts");
  const bodies: string[] = [];
  const settings = {
    dsn: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
    environment: "production-eu",
    release: "2026.10.24-fixture",
    strictPrivacy: true,
  };
  const [stackPriority, parseStackLine] = nodeStackLineParser();
  const client = new CloudflareClient({
    ...settings,
    integrations: [],
    tracesSampleRate: 0,
    sendDefaultPii: false,
    stackParser: createStackParser([stackPriority, parseStackLine]),
    beforeSend: sentryBeforeSend(settings),
    transport: (options: unknown) => createTransport(options, async (request: { body: string | Uint8Array }) => {
      bodies.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
      return { statusCode: 200, headers: {} };
    }),
  });
  client.init();
  const scope = new (requireCloud("@sentry/core").Scope)();
  scope.setUser({ id: "account_fixture_7", email: "private-person@example.invalid", ip_address: "192.0.2.7" });
  scope.setTag("auth_token", "fixture-secret-token");
  scope.setExtra("request_body", "private prompt and response");
  scope.setContext("request", { url: "https://private.invalid/path?token=fixture-secret-token" });
  scope.setContext("trace", {
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: "0123456789abcdef",
    private_note: "remove this context field",
  });
  scope.addBreadcrumb({ message: "private breadcrumb content", data: { token: "fixture-secret-token" } });
  client.captureException(new Error("private-person@example.invalid token=fixture-secret-token body=private prompt"), undefined, scope);
  await client.flush(2000);
  client.dispose();

  assert.equal(bodies.length, 1);
  const envelopeLines = bodies[0]!.split("\n");
  const payloadLine = envelopeLines.find((line) => line.startsWith("{\"event_id\":" ) && line.includes("UnhandledFailure"));
  const payload = payloadLine ? JSON.parse(payloadLine) as Record<string, unknown> : undefined;
  assert.ok(payload, "Sentry SDK emitted a sanitized error event");
  assert.equal(payload.message, "UnhandledFailure");
  assert.deepEqual(payload.exception, { values: [{ type: "UnhandledFailure" }] });
  assert.deepEqual(payload.fingerprint, ["basalt", "UnhandledFailure"]);
  assert.deepEqual(payload.user, { id: "account_fixture_7" });
  assert.deepEqual(payload.contexts, { trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" } });
  assert.equal(payload.release, settings.release);
  assert.equal(payload.environment, settings.environment);
  for (const forbidden of ["private-person@example.invalid", "fixture-secret-token", "private prompt", "private response", "private breadcrumb", "private.invalid", "192.0.2.7", "auth_token", "request_body"]) {
    assert.equal(bodies[0]!.includes(forbidden), false, `serialized event excludes ${forbidden}`);
  }
});

test("strict OTLP output contains only safe spans and fixed resource labels", async () => {
  const { strictPrivacyTraceData } = await load("packages/telemetry/src/isolate.ts");
  const config = { service: "executor-cloud", version: "2026.10.24-fixture", environment: "production-eu" };
  const sanitized = strictPrivacyTraceData({
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "private resource value" } },
          { key: "cloud.account.token", value: { stringValue: "fixture-secret-token" } },
        ],
        droppedAttributesCount: 0,
      },
      scopeSpans: [{
        scope: { name: "private instrumentation scope" },
        spans: [{
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "0123456789abcdef",
          parentSpanId: "fedcba9876543210",
          name: "POST /api/v1/organizations/private-account/projects/private-project",
          kind: 2,
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
          attributes: [
            { key: "http.request.method", value: { stringValue: "POST" } },
            { key: "http.route", value: { stringValue: "/api/v1/organizations/:private_account/projects/private-project" } },
            { key: "http.response.status_code", value: { intValue: 500 } },
            { key: "url.full", value: { stringValue: "https://private.invalid/path?token=fixture-secret-token" } },
            { key: "user.email", value: { stringValue: "private-person@example.invalid" } },
            { key: "exception.message", value: { stringValue: "private prompt body" } },
            { key: "exception.stacktrace", value: { stringValue: "at /private/local/path.ts" } },
            { key: "db.statement", value: { stringValue: "select 'private prompt'" } },
          ],
          droppedAttributesCount: 0,
          events: [{
            name: "exception",
            timeUnixNano: "2000000",
            droppedAttributesCount: 0,
            attributes: [{ key: "exception.message", value: { stringValue: "fixture-secret-token" } }],
          }],
          droppedEventsCount: 0,
          status: { code: 2, message: "private prompt and token=fixture-secret-token" },
          links: [{
            traceId: "fedcba9876543210fedcba9876543210",
            spanId: "fedcba9876543210",
            droppedAttributesCount: 0,
            attributes: [{ key: "private", value: { stringValue: "private context" } }],
          }],
          droppedLinksCount: 0,
        }],
      }],
    }],
  }, config);
  const json = await Effect.runPromise(
    OtlpSerialization.OtlpSerialization.pipe(Effect.provide(OtlpSerialization.layerJson)),
  );
  const body = json.traces(sanitized);
  assert.equal(body._tag, "Uint8Array");
  const serialized = typeof body.text === "string" ? body.text : new TextDecoder().decode(body.body);
  const exported = JSON.parse(serialized) as {
    resourceSpans: [{
      resource: { attributes: { key: string; value: Record<string, unknown> }[] };
      scopeSpans: [{ scope: { name: string }; spans: [Record<string, unknown>] }];
    }];
  };
  const resourceSpan = exported.resourceSpans[0]!;
  const scopeSpan = resourceSpan.scopeSpans[0]!;
  const span = scopeSpan.spans[0]!;
  assert.deepEqual(resourceSpan.resource.attributes, [
    { key: "service.name", value: { stringValue: "executor-cloud" } },
    { key: "service.version", value: { stringValue: "2026.10.24-fixture" } },
    { key: "deployment.environment.name", value: { stringValue: "production-eu" } },
  ]);
  assert.equal(scopeSpan.scope.name, "basalt.telemetry");
  assert.equal(span.name, "POST /api/v1/organizations/:segment/projects/:segment");
  assert.equal(span.status && (span.status as { code: number }).code, 2);
  assert.equal("message" in (span.status as Record<string, unknown>), false);
  assert.deepEqual(span.events, []);
  assert.deepEqual(span.links, []);
  assert.deepEqual(span.attributes, [
    { key: "http.request.method", value: { stringValue: "POST" } },
    { key: "http.route", value: { stringValue: "/api/v1/organizations/:segment/projects/:segment" } },
    { key: "http.response.status_code", value: { intValue: 500 } },
  ]);
  for (const forbidden of ["private-account", "private_account", "private-project", "fixture-secret-token", "private.invalid", "private-person@example.invalid", "private prompt", "private local path", "select"]) {
    assert.equal(serialized.includes(forbidden), false, `serialized traces exclude ${forbidden}`);
  }
});

test("direct Sentry trace mode avoids the Cloudflare platform trace destination", async () => {
  const telemetry = await load("apps/hosted/cloud/src/infrastructure/telemetry.ts");
  const { AlchemyContext } = requireCloud("alchemy/AlchemyContext");
  const { Stage } = requireCloud("alchemy/Stage");
  const { ConfigProvider } = requireTelemetry("effect");
  const result = await Effect.runPromise(telemetry.cloudObservability.pipe(
    Effect.provideService(AlchemyContext, { dev: false }),
    Effect.provideService(Stage, "fixture"),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {
      SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
      SENTRY_OTLP_ENDPOINT: "https://o123.ingest.de.sentry.io/api/456/integration/otlp/v1/traces",
      // Available Axiom settings must not provision a fallback platform exporter in direct mode.
      AXIOM_TOKEN: "synthetic-axiom-token",
    } }))),
  ));
  assert.deepEqual(result, {});
});
