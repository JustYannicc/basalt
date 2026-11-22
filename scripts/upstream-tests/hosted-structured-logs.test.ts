import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const requireCloud = createRequire(
  pathToFileURL(resolve(upstream, "apps/hosted/cloud/package.json")),
);
const {
  Cause,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Schema,
  Scope,
  Tracer,
} = requireCloud("effect");
const { RuntimeContext } = requireCloud("alchemy/RuntimeContext");
const { buildEventTelemetry } = requireCloud("alchemy/Telemetry");
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const { cloudTelemetry } = await load("apps/hosted/cloud/src/infrastructure/telemetry.ts");
const { reportCatalogApp } = await load(
  "apps/hosted/server/src/implementation/catalog-app-records.ts",
);
const { recordAs } = await load("packages/utils/src/recorded-message.ts");

type Call = { method: string; args: unknown[] };
type Line = {
  message: unknown;
  level: string;
  timestamp: string;
  cause?: string;
  annotations: Record<string, unknown>;
  spans: Record<string, number>;
  fiberId: string;
};

/** Direct Sentry mode: traces only, so the isolate's console sink is the only log output. */
const tracesOnly = JSON.stringify({
  service: "executor-cloud",
  version: "fixture",
  environment: "fixture",
  clock: "cloudflare-io",
  strictPrivacy: true,
  traces: { url: "https://telemetry.invalid/v1/traces" },
});

/** `cloudTelemetry` installs nothing outside an Alchemy runtime, as during a deploy's plan. */
const runtimeFlag = globalThis as typeof globalThis & { __ALCHEMY_RUNTIME__?: boolean };
const inAlchemyRuntime = <A>(run: () => Promise<A>) => {
  const previous = runtimeFlag.__ALCHEMY_RUNTIME__;
  runtimeFlag.__ALCHEMY_RUNTIME__ = true;
  return run().finally(() => {
    runtimeFlag.__ALCHEMY_RUNTIME__ = previous;
  });
};
const runtimeContext = (binding: string): Record<string, unknown> => ({
  Type: "Cloudflare.Worker",
  id: "Api",
  env: {},
  get: () => Effect.succeed(binding),
  set: (key: string) => Effect.succeed(key),
});

const capture = async <A>(run: () => Promise<A>) => {
  const calls: Call[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "group", "groupEnd"] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const method of methods)
    console[method] = (...args: unknown[]) => void calls.push({ method, args });
  try {
    return { calls, value: await run() };
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
};

/**
 * Run `effect` as one event of the hosted Worker the way Alchemy's bridges do: the Worker's
 * initialization registers its telemetry on the runtime context, and each event builds that
 * Layer over the isolate context, whose logger is Alchemy's platform `consolePretty`.
 */
const asHostedEvent = (binding: string, effect: unknown) => {
  const runtime = runtimeContext(binding);
  return capture(() =>
    inAlchemyRuntime(() =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const isolate = yield* Layer.build(
              Layer.mergeAll(
                Logger.layer([Logger.consolePretty()]),
                ConfigProvider.layer(ConfigProvider.fromUnknown({})),
                Layer.succeed(RuntimeContext, runtime),
              ),
            );
            yield* Layer.build(cloudTelemetry).pipe(Effect.provideContext(isolate));
            const scope = yield* Scope.make();
            const event = yield* buildEventTelemetry(isolate, scope, runtime.telemetry);
            const exit = yield* Effect.exit(
              Effect.provideContext(effect, Context.merge(isolate, event)),
            );
            yield* Scope.close(scope, Exit.void);
            return yield* exit;
          }),
        ),
      ),
    ),
  );
};

const oneLine = (calls: Call[]): Line => {
  assert.deepEqual(
    calls.map((call) => call.method),
    ["log"],
    `expected one console.log call, got ${JSON.stringify(calls)}`,
  );
  const [call] = calls;
  assert.equal(call.args.length, 1, "the line must be a single console argument");
  const [line] = call.args;
  assert.equal(typeof line, "object");
  assert.notEqual(line, null);
  return line as Line;
};

const storesNone = (line: unknown, secrets: ReadonlyArray<string>) => {
  const stored = JSON.stringify(line);
  for (const secret of secrets) assert.ok(!stored.includes(secret), `the line stores ${secret}`);
};

const sweepLine = reportCatalogApp("org_fixture", "app_fixture", "offered", null, {
  entry: "github",
  offer: { reasons: ["accounts"], reconnect: 1 },
});

for (const [mode, binding] of [
  ["without telemetry exporters", "null"],
  ["with the direct Sentry trace exporter", tracesOnly],
] as const) {
  test(`a catalog sweep line reaches the console as one object with its fields, ${mode}`, async () => {
    const { calls } = await asHostedEvent(binding, sweepLine);
    const line = oneLine(calls);
    assert.ok(Array.isArray(line.message));
    const [head, fields] = line.message as [unknown, Record<string, unknown>];
    assert.equal(head, "Catalog app update");
    assert.equal(fields.entry, "github");
    assert.equal(fields.decision, "offered");
    assert.deepEqual(fields.reasons, ["accounts"]);
    assert.equal(fields.reconnect, 1);
    assert.equal(line.level, "INFO");
    assert.deepEqual(Object.keys(line).sort(), [
      "annotations",
      "cause",
      "fiberId",
      "level",
      "message",
      "spans",
      "timestamp",
    ]);
  });
}

const RemovalStorageFailed = Schema.TaggedError()("RemovalStorageFailed", {
  connection: Schema.String,
  row: Schema.Unknown,
  message: Schema.String,
});

const connection = "postgres://fixture:fixture-password@database.invalid:5432/product";
const storageFailure = () =>
  new RemovalStorageFailed({
    connection,
    row: { email: "person@example.com", name: "Pat Example" },
    message:
      'duplicate key value violates unique constraint "users_email_key"\nDETAIL: Key (email)=(person@example.com)',
  });
const secrets = [
  "fixture-password",
  "postgres://",
  "person@example.com",
  "Pat Example",
  "users_email_key",
  "fixture0123",
  "DETAIL",
  "    at ",
];

const removalCause = () =>
  Cause.fromReasons([
    Cause.makeFailReason(storageFailure()),
    Cause.makeFailReason(recordAs(storageFailure(), "The removal step could not save its record")),
    Cause.makeDieReason(
      new Error(
        "fetch failed for https://api.example.com/v1/users?session=fixture0123456789abcdef with person@example.com",
      ),
    ),
    Cause.makeDieReason(
      new Error("Service not found: OrganizationRemovalRecovery for session fixture0123abcdef4567"),
    ),
    Cause.makeDieReason({ session: "fixture0123456789abcdef" }),
    Cause.makeInterruptReason(7),
  ]);

test("a cause keeps a tagged error's tag and declared sentence, and an Error's scrubbed first line", async () => {
  const { calls } = await asHostedEvent(
    "null",
    Effect.logError("Organization removal step failed", removalCause()),
  );
  const line = oneLine(calls);
  assert.equal(line.message, "Organization removal step failed");
  assert.equal(
    line.cause,
    [
      "RemovalStorageFailed",
      "RemovalStorageFailed: The removal step could not save its record",
      "Error: fetch failed for <url> with <email>",
      "Error: Service not found: OrganizationRemovalRecovery for session <value>",
      "UnrecognizedFailure",
      "Interrupted",
    ].join("\n"),
  );
  storesNone(line, secrets);
});

test("Effect's own structured logger stores what the hosted logger reduces", async () => {
  // The control for the assertions above: they detect what a plain `consoleStructured` stores.
  const { calls } = await capture(() =>
    Effect.runPromise(
      Effect.logError("Organization removal step failed", removalCause(), storageFailure()).pipe(
        Effect.provide(Logger.layer([Logger.consoleStructured])),
      ),
    ),
  );
  const stored = JSON.stringify(calls);
  for (const secret of ["fixture-password", "person@example.com", "DETAIL", "    at "])
    assert.ok(stored.includes(secret), `consoleStructured would not store ${secret}`);
});

test("errors in message parts, fields, containers and annotations keep only their name and message", async () => {
  const throwing = {
    get value(): never {
      throw new Error("a getter that throws");
    },
  };
  const { calls } = await asHostedEvent(
    "null",
    Effect.logWarning(
      "Executor app redeploy failed",
      "app_123",
      storageFailure(),
      {
        attempt: 2,
        failures: [new TypeError("Unexpected token in 'secret-value'")],
        decoded: {
          _tag: "AccountLookupFailed",
          message: "No account for person@example.com",
          email: "person@example.com",
        },
        maybe: Option.some(storageFailure()),
        none: Option.none(),
        exit: Exit.fail(storageFailure()),
        nested: { cause: Cause.fail(storageFailure()) },
      },
      throwing,
    ).pipe(Effect.annotateLogs({ app: "app_123", failure: storageFailure() })),
  );
  const line = oneLine(calls);
  const tagged = { name: "RemovalStorageFailed" };
  assert.deepEqual(line.message, [
    "Executor app redeploy failed",
    "app_123",
    tagged,
    {
      attempt: 2,
      failures: [{ name: "TypeError", message: "Unexpected token in <value>" }],
      decoded: { name: "AccountLookupFailed" },
      maybe: { _tag: "Some", value: tagged },
      none: Option.none(),
      exit: { _tag: "Failure", cause: "RemovalStorageFailed" },
      nested: { cause: "RemovalStorageFailed" },
    },
    "<unloggable>",
  ]);
  assert.deepEqual(line.annotations, { app: "app_123", failure: tagged });
  assert.equal(line.cause, undefined);
  storesNone(line, [...secrets, "secret-value", "No account"]);
});

test("an app page failure logs its cause and config keys, never a rendered cause", async () => {
  const { logAppPageFailure } = await load(
    "apps/hosted/cloud/src/implementation/app-page-failure.ts",
  );
  const configError = {
    _tag: "ConfigError",
    cause: { issue: { _tag: "Pointer", path: ["APP_UI_BASE"], issue: { _tag: "MissingKey" } } },
  };
  const { calls } = await asHostedEvent(
    "null",
    logAppPageFailure(
      Cause.fromReasons([
        Cause.makeFailReason(configError),
        Cause.makeDieReason(
          new Error('Unexpected token in request body {"email":"person@example.com"}'),
        ),
      ]),
    ),
  );
  const line = oneLine(calls);
  assert.deepEqual(line.message, ["App page failed", { config: ["APP_UI_BASE: MissingKey"] }]);
  assert.equal(
    line.cause,
    "ConfigError\nError: Unexpected token in request body {<value>:<value>}",
  );
  storesNone(line, ["person@example.com", "    at "]);
});

test("spans keep a log event per line, with the same reduced annotations and cause", async () => {
  const events: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  const tracer = Tracer.make({
    span: (options: unknown) =>
      Object.assign(new Tracer.NativeSpan(options), {
        event: (name: string, _time: bigint, attributes?: Record<string, unknown>) =>
          void events.push({ name, attributes: attributes ?? {} }),
      }),
  });
  await asHostedEvent(
    "null",
    Effect.logError("Organization removal step failed", Cause.fail(storageFailure())).pipe(
      Effect.annotateLogs({ organization: "org_fixture", failure: storageFailure() }),
      Effect.withSpan("organization.removal.step"),
      Effect.withTracer(tracer),
    ),
  );
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.name, "Organization removal step failed");
  assert.equal(event.attributes["effect.logLevel"], "ERROR");
  assert.equal(event.attributes["effect.cause"], "RemovalStorageFailed");
  assert.equal(event.attributes.organization, "org_fixture");
  assert.deepEqual(event.attributes.failure, { name: "RemovalStorageFailed" });
  storesNone(event, secrets);
});

test("span events join an exporter's loggers instead of replacing them", async () => {
  const { hostedConsoleLogger, withHostedSpanEvents } = await load(
    "apps/hosted/cloud/src/implementation/structured-logs.ts",
  );
  const remote = Logger.make(() => undefined);
  // An exporter context: its console sink, a remote log exporter and another service it provides.
  const exporters = Layer.mergeAll(
    Logger.layer([hostedConsoleLogger, remote]),
    Layer.succeed(Logger.LogToStderr, true),
  );
  const context = await Effect.runPromise(
    Effect.scoped(Layer.build(withHostedSpanEvents(exporters))),
  );
  const loggers = Context.get(context, Logger.CurrentLoggers);
  assert.equal(loggers.size, 3);
  assert.ok(loggers.has(hostedConsoleLogger));
  assert.ok(loggers.has(remote));
  assert.equal(Context.get(context, Logger.LogToStderr), true);
});

test("the Worker's own initialization logs one object per line too", async () => {
  const { calls } = await capture(() =>
    inAlchemyRuntime(() =>
      Effect.runPromise(
        sweepLine.pipe(
          Effect.provide(cloudTelemetry),
          Effect.provide(
            Layer.mergeAll(
              Logger.layer([Logger.consolePretty()]),
              Layer.succeed(RuntimeContext, runtimeContext("null")),
            ),
          ),
        ),
      ),
    ),
  );
  const line = oneLine(calls);
  assert.equal((line.message as unknown[])[0], "Catalog app update");
});
