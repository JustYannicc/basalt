import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Scope } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
export const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const reporting: {
  readonly withCloudSentry: <A, E, R>(
    handler: Effect.Effect<A, E, R>,
    settings: Effect.Effect<unknown>,
  ) => Effect.Effect<A, E, R | Scope.Scope>;
} = await load("apps/hosted/cloud/src/implementation/error-reporting.ts");

export type SentryEvent = {
  readonly message?: unknown;
  readonly exception?: { readonly values?: readonly { type?: unknown; value?: unknown }[] };
  readonly tags?: Readonly<Record<string, unknown>>;
  readonly fingerprint?: unknown;
  readonly [key: string]: unknown;
};

const received: SentryEvent[] = [];
const ingest = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    for (const line of body.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null && "exception" in value)
          received.push(value as SentryEvent);
      } catch {
        // Envelope headers that are not events are skipped.
      }
    }
    response.writeHead(200);
    response.end("{}");
  });
});
await new Promise<void>((done, fail) => {
  ingest.once("error", fail);
  ingest.listen(0, "127.0.0.1", done);
});
after(
  () =>
    new Promise<void>((done) => {
      ingest.closeAllConnections();
      ingest.close(() => done());
    }),
);
const address = ingest.address();
assert.ok(address !== null && typeof address !== "string");
const dsn = `http://synthetic@127.0.0.1:${address.port}/1`;

/** Run `work` under the cloud's request Sentry client; the events are what its ingest received. */
export const underSentry = <A, E, R>(work: Effect.Effect<A, E, R>, strictPrivacy = true) =>
  Effect.gen(function* () {
    received.length = 0;
    const settings = {
      dsn,
      environment: "test-pool-app",
      release: "pool-app-failure-fixture",
      strictPrivacy,
    };
    const result = yield* Effect.scoped(reporting.withCloudSentry(work, Effect.succeed(settings)));
    return { result, events: [...received] };
  });

export const reported = <A, E>(work: Effect.Effect<A, E>, strictPrivacy = true) =>
  Effect.runPromise(underSentry(work, strictPrivacy));

/** The JSON a route answered with. */
export const responseBody = (response: { readonly body: unknown }): unknown => {
  const body = response.body;
  assert.ok(
    typeof body === "object" && body !== null && "body" in body && body.body instanceof Uint8Array,
    "the route answered a JSON body",
  );
  return JSON.parse(new TextDecoder().decode(body.body));
};

export const routeTag = "executor.pool_app.route";
export const refusalTag = "executor.pool_app.refusal";
