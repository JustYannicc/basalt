/**
 * Root writes the wire guard must refuse, from the adversarial read of its root rule: a write spelled
 * other than the SDK spells it, and a write the server redirects. The local server answers the
 * shapes Alchemy's container provider sends and expects.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Cause, Effect, Exit } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { install, WireRefused, type WireGuardConfig } from "./wire-guard.ts";
import { ACCOUNT, applicationBody, credentials } from "./test/wire-guard-fixture.ts";

const RECORDED = "11111111-1111-4111-8111-111111111111";
const NAME = "basalt-production-poolcontainer";
const root = { ...applicationBody(RECORDED), name: NAME };
const envelope = (result: unknown) =>
  JSON.stringify({ success: true, errors: [], messages: [], result });

const startServer = async (
  t: TestContext,
  answer: (path: string) => { status: number; location: string } | undefined = () => undefined,
) => {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    const path = request.url ?? "";
    received.push(`${request.method} ${path}`);
    const redirect = answer(path);
    if (redirect) {
      response.statusCode = redirect.status;
      response.setHeader("location", redirect.location);
      return response.end();
    }
    response.setHeader("content-type", "application/json");
    response.end(envelope(root));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received };
};

const guarded = <A, E>(config: WireGuardConfig, run: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install(config);
        return yield* Effect.exit(
          run.pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(guard.layer)),
        );
      }),
    ),
  );

const refusalOf = (exit: Exit.Exit<unknown, unknown>): WireRefused => {
  assert.ok(Exit.isFailure(exit), "expected the request to be refused");
  let error: unknown = Cause.squash(exit.cause);
  for (let depth = 0; depth < 8 && !(error instanceof WireRefused); depth++) {
    const next = error as { cause?: unknown; reason?: unknown; error?: unknown } | undefined;
    error = next?.reason ?? next?.cause ?? next?.error;
  }
  assert.ok(
    error instanceof WireRefused,
    `no wire guard refusal in ${String(Cause.squash(exit.cause))}`,
  );
  return error;
};

test("a root write in a spelling the guard cannot parse is refused, not admitted", async (t) => {
  const server = await startServer(t);
  const a = `/accounts/${ACCOUNT}`;
  for (const path of [
    `/client/v4${a}/Containers/Applications/${RECORDED}`,
    `/client/v4/Accounts/${ACCOUNT}/containers/applications/${RECORDED}`,
    `/client/v4${a}/containers/applications/${RECORDED.toUpperCase()}`,
    `/client/v4${a}/containers//applications/${RECORDED}`,
    `/client/v4${a}/containers/applications//${RECORDED}`,
    `/client/v4${a}//containers/applications/${RECORDED}`,
    `/client/v4${a}/containers/%61pplications/${RECORDED}`,
    `/client/v4${a}/containers/applications%2F${RECORDED}`,
    `/client/v4${a}/containers/applications/${RECORDED};v=1`,
    `/client/v4${a}/containers/applications/${RECORDED}%2Frollouts`,
    `/user/x/client/v4${a}/containers/applications/${RECORDED}`,
  ]) {
    const exit = await guarded(
      { rootApplications: [RECORDED], rootApplicationNames: [NAME] },
      HttpClient.execute(HttpClientRequest.patch(`${server.base}${path}`)),
    );
    refusalOf(exit);
    assert.deepEqual(
      server.received.filter((line) => !line.startsWith("GET ")),
      [],
      path,
    );
  }
});

test("an admitted write that the server redirects is never re-sent to the root", async (t) => {
  // fetch follows 302/307/308 for a PATCH with the same method and body; the guard checks only the
  // first address.
  const server = await startServer(t, (path) =>
    path.endsWith("/applications/cell-app")
      ? { status: 307, location: path.replace("cell-app", RECORDED) }
      : undefined,
  );
  await guarded(
    { rootApplications: [RECORDED], rootApplicationNames: [NAME] },
    Containers.updateContainerApplication({
      accountId: ACCOUNT,
      applicationId: "cell-app",
      maxInstances: 2,
    } as Containers.UpdateContainerApplicationRequest).pipe(Retry.none, credentials(server.base)),
  );
  assert.ok(
    server.received.some((line) => line.includes("cell-app")),
    "the admitted write was sent",
  );
  assert.ok(!server.received.some((line) => line.includes(RECORDED)), server.received.join(" ; "));
});
