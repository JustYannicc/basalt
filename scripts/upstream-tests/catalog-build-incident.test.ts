import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { Effect, ErrorReporter, Logger, References } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const [failures, incidents, reporting, versions] = await Promise.all([
  load("apps/hosted/server/src/implementation/catalog-build-failure.ts"),
  load("apps/hosted/cloud/src/implementation/catalog-build-incident.ts"),
  load("apps/hosted/cloud/src/implementation/error-reporting.ts"),
  load("packages/sdk/src/contracts/version.ts"),
]);

const app = "app_11111111-1111-4111-8111-111111111111";
const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const incident = (cause: string, phase = "deployment", attempt = "2") => ({
  exception: { values: [{ type: "CatalogBuildResourceFailed", value: "private source" }] },
  tags: {
    "executor.app.id": app,
    "executor.catalog.resource_failure": cause,
    "executor.catalog.phase": phase,
    "executor.provisioning.attempt": attempt,
  },
  contexts: { trace: { trace_id: traceId, span_id: spanId } },
});

test("compiler resource errors emit one closed operational incident and safe attempt logs", async () => {
  const errors: string[] = [];
  const logs: { message: unknown; annotations: Readonly<Record<string, unknown>> }[] = [];
  const reporter = ErrorReporter.make(({ error }) => errors.push(error.name));
  const capture = Logger.make(({ message, fiber }) => {
    logs.push({
      message: Array.isArray(message) ? message[0] : message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  const cases = [
    [new versions.BuildMemoryExceeded(), "memory", "requirements"],
    [new versions.BuildBusy(), "capacity", "deployment"],
    [
      new versions.VersionBuildFailed({
        owner: "organization:team",
        name: "app",
        reason: "App build failed",
        stage: "compile",
        message: "The compiler did not answer",
        unanswered: true,
      }),
      "unanswered",
      "deployment",
    ],
    [
      new versions.BuildUnanswered({ owner: "organization:team", name: "app" }),
      "unanswered",
      "deployment",
    ],
  ] as const;

  for (const [index, [error, , phase]] of cases.entries()) {
    await Effect.runPromise(
      failures
        .reportCatalogResourceFailure(error, { organization: "org_team", app, entry: "crm", phase })
        .pipe(
          Effect.annotateLogs({ job: "catalog-job-1", attempt: 2 }),
          Effect.withSpan("catalog-attempt"),
          Effect.provide(ErrorReporter.layer([reporter])),
          Effect.provide(Logger.layer([capture])),
        ),
    );
    assert.equal(errors.length, index + 1);
  }

  assert.equal(errors.length, 4);
  assert.deepEqual(errors, Array(4).fill("CatalogBuildResourceFailed"));
  const resourceLogs = logs.filter(
    (value) => value.message === "Catalog app update resource failure",
  );
  assert.equal(resourceLogs.length, 4);
  const expected = [
    { app, cause: "memory", entry: "crm", phase: "requirements" },
    { app, cause: "capacity", entry: "crm", phase: "deployment" },
    { app, cause: "unanswered", entry: "crm", phase: "deployment" },
    { app, cause: "unanswered", entry: "crm", phase: "deployment" },
  ];
  for (const [index, item] of resourceLogs.entries()) {
    assert.deepEqual(
      {
        app: item.annotations.app,
        cause: item.annotations.cause,
        entry: item.annotations.entry,
        phase: item.annotations.phase,
      },
      expected[index],
    );
    assert.ok(typeof item.annotations.trace === "string" && item.annotations.trace.length > 0);
    assert.equal(item.annotations.job, "catalog-job-1");
    assert.equal(item.annotations.attempt, 2);
  }
});

test("ordinary source failures do not become operational compiler incidents", async () => {
  const errors: string[] = [];
  const reporter = ErrorReporter.make(({ error }) => errors.push(error.name));
  await Effect.runPromise(
    failures
      .reportCatalogResourceFailure(
        new versions.VersionBuildFailed({
          owner: "organization:team",
          name: "app",
          reason: "Invalid source files",
          stage: "source",
          message: "App build failed: the source files are invalid.",
        }),
        {
          organization: "org_team",
          app,
          entry: "crm",
          phase: "requirements",
        },
      )
      .pipe(Effect.provide(ErrorReporter.layer([reporter]))),
  );
  assert.deepEqual(errors, []);
});

test("strict Sentry projection keeps only validated catalog fields and trace IDs", async () => {
  const { sentryBeforeSend } = await reporting;
  const beforeSend = sentryBeforeSend({
    dsn: "https://synthetic@example.ingest.de.sentry.io/1",
    environment: "test-catalog",
    release: "fixture-release",
    strictPrivacy: true,
  });
  const projected = beforeSend({
    event_id: "a".repeat(32),
    message: "private source text",
    exception: incident("memory").exception,
    tags: {
      ...incident("memory").tags,
      source: "https://private.invalid/app?token=secret",
      email: "person@example.invalid",
    },
    contexts: {
      ...incident("memory").contexts,
      request: { url: "https://private.invalid/?token=secret" },
    },
    extra: { source: "private source", token: "secret" },
    user: { id: "person-id", email: "person@example.invalid" },
  });
  assert.equal(projected.message, "CatalogBuildResourceFailed");
  assert.deepEqual(projected.tags, incident("memory").tags);
  assert.deepEqual(projected.contexts, { trace: { trace_id: traceId, span_id: spanId } });
  assert.deepEqual(projected.user, { id: "person-id" });
  assert.equal("extra" in projected, false);
  assert.equal(JSON.stringify(projected).includes("private"), false);
  assert.equal(JSON.stringify(projected).includes("secret"), false);

  const unhandled = beforeSend({
    message: "private source text",
    exception: { values: [{ type: "UnhandledFailure", value: "private" }] },
    tags: incident("memory").tags,
    extra: { source: "private" },
  });
  assert.equal(unhandled.message, "UnhandledFailure");
  assert.equal("tags" in unhandled, false);
  assert.equal("extra" in unhandled, false);
});

test("malformed catalog diagnostics never cross the incident privacy boundary", async () => {
  const { catalogBuildIncident } = await incidents;
  for (const candidate of [
    incident("memory", "compile", "2"),
    incident("private source text", "deployment", "2"),
    incident("memory", "deployment", "1000"),
    {
      ...incident("memory"),
      tags: { ...incident("memory").tags, "executor.app.id": "https://private.invalid" },
    },
    { ...incident("memory"), exception: { values: [{ type: "UnhandledFailure" }] } },
  ])
    assert.equal(catalogBuildIncident(candidate), undefined);

  const safe = catalogBuildIncident(incident("memory"));
  assert.deepEqual(safe, {
    "executor.app.id": app,
    "executor.catalog.resource_failure": "memory",
    "executor.catalog.phase": "deployment",
    "executor.provisioning.attempt": "2",
  });
});

test("withCloudSentry flushes one closed catalog incident to a loopback transport", async () => {
  const { withCloudSentry } = await reporting;
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200);
      response.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Loopback listener did not bind a TCP port");
    const settings = {
      dsn: `http://synthetic@127.0.0.1:${address.port}/1`,
      environment: "test-catalog",
      release: "catalog-incident-fixture",
      strictPrivacy: true,
    };
    const work = Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("executor.provisioning.attempt", 2);
      yield* failures.reportCatalogResourceFailure(new versions.BuildMemoryExceeded(), {
        organization: "org_team",
        app,
        entry: "crm",
        phase: "deployment",
      });
    }).pipe(
      Effect.annotateLogs({ job: "catalog-job-1", attempt: 2 }),
      Effect.withSpan("catalog-resource-failure"),
    );

    await Effect.runPromise(Effect.scoped(withCloudSentry(work, Effect.succeed(settings))));

    assert.equal(bodies.length, 1, "scope release flushes one Sentry envelope");
    const payloads = bodies[0]!
      .split("\n")
      .flatMap((line) => {
        if (!line.startsWith("{")) return [];
        try {
          const value: unknown = JSON.parse(line);
          return typeof value === "object" && value !== null
            ? [value as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      })
      .filter((value) => value.message === "CatalogBuildResourceFailed");
    assert.equal(payloads.length, 1);
    const payload = payloads[0]!;
    assert.deepEqual(payload.exception, { values: [{ type: "CatalogBuildResourceFailed" }] });
    assert.deepEqual(payload.tags, {
      "executor.app.id": app,
      "executor.catalog.resource_failure": "memory",
      "executor.catalog.phase": "deployment",
      "executor.provisioning.attempt": "2",
    });
    const contexts = payload.contexts as { trace?: { trace_id?: unknown; span_id?: unknown } };
    assert.ok(
      typeof contexts.trace?.trace_id === "string" &&
        /^[0-9a-f]{32}$/.test(contexts.trace.trace_id),
    );
    assert.ok(
      typeof contexts.trace?.span_id === "string" && /^[0-9a-f]{16}$/.test(contexts.trace.span_id),
    );
    assert.equal(payload.release, settings.release);
    assert.equal(payload.environment, settings.environment);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
